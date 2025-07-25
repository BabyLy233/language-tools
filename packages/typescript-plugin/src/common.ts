import type * as ts from 'typescript'
import type { RequestContext } from './requests/types'

import {
  Language,
  MpxCompilerOptions,
  MpxVirtualCode,
  forEachElementNode,
  hyphenateTag,
} from '@mpxjs/language-core'
import { capitalize } from '@mpxjs/language-shared'
import { _getComponentNames } from './requests/getComponentNames'
import { _getElementNames } from './requests/getElementNames'

const windowsPathReg = /\\/g

export function proxyLanguageServiceForMpx<T>(
  ts: typeof import('typescript'),
  language: Language<T>,
  languageService: ts.LanguageService,
  mpxOptions: MpxCompilerOptions,
  asScriptId: (fileName: string) => T,
) {
  const proxyCache = new Map<
    string | symbol,
    ((...args: any[]) => any) | undefined
  >()
  const getProxyMethod = (
    target: ts.LanguageService,
    p: string | symbol,
  ): ((...args: any[]) => any) | undefined => {
    switch (p) {
      case 'getCompletionsAtPosition':
        return getCompletionsAtPosition(mpxOptions, target[p])
      case 'getCompletionEntryDetails':
        return getCompletionEntryDetails(language, asScriptId, target[p])
      case 'getCodeFixesAtPosition':
        return getCodeFixesAtPosition(target[p])
      case 'getDefinitionAndBoundSpan':
        return getDefinitionAndBoundSpan(
          ts,
          language,
          languageService,
          mpxOptions,
          asScriptId,
          target[p],
        )
      case 'getQuickInfoAtPosition':
        return getQuickInfoAtPosition(ts, target, target[p])
      // TS plugin only
      case 'getEncodedSemanticClassifications':
        return getEncodedSemanticClassifications(
          ts,
          language,
          target,
          asScriptId,
          target[p],
        )
    }
  }

  return new Proxy(languageService, {
    get(target, p, receiver) {
      if (getProxyMethod) {
        if (!proxyCache.has(p)) {
          proxyCache.set(p, getProxyMethod(target, p))
        }
        const proxyMethod = proxyCache.get(p)
        if (proxyMethod) {
          return proxyMethod
        }
      }
      return Reflect.get(target, p, receiver)
    },
    set(target, p, value, receiver) {
      return Reflect.set(target, p, value, receiver)
    },
  })
}

function getCompletionsAtPosition(
  mpxOptions: MpxCompilerOptions,
  getCompletionsAtPosition: ts.LanguageService['getCompletionsAtPosition'],
): ts.LanguageService['getCompletionsAtPosition'] {
  return (filePath, position, options, formattingSettings) => {
    const fileName = filePath.replace(windowsPathReg, '/')
    const result = getCompletionsAtPosition(
      fileName,
      position,
      options,
      formattingSettings,
    )
    if (result) {
      // filter __VLS_
      result.entries = result.entries.filter(
        entry =>
          !entry.name.includes('__VLS_') &&
          !entry.labelDetails?.description?.includes('__VLS_'),
      )
      // modify label
      for (const item of result.entries) {
        if (item.source) {
          const originalName = item.name
          for (const mpxExt of mpxOptions.extensions) {
            const suffix = capitalize(mpxExt.slice(1)) // .mpx -> Mpx
            if (item.source.endsWith(mpxExt) && item.name.endsWith(suffix)) {
              item.name = capitalize(item.name.slice(0, -suffix.length))
              if (item.insertText) {
                item.insertText = item.insertText.replace(`${suffix}$1`, '$1')
              }
              if (item.data) {
                // @ts-expect-error ignore
                item.data.__isComponentAutoImport = {
                  ext: mpxExt,
                  suffix,
                  originalName,
                  newName: item.insertText,
                }
              }
              break
            }
          }
          if (item.data) {
            // @ts-expect-error ignore
            item.data.__isAutoImport = {
              fileName,
            }
          }
        }
      }
    }
    return result
  }
}

function getCompletionEntryDetails<T>(
  language: Language<T>,
  asScriptId: (fileName: string) => T,
  getCompletionEntryDetails: ts.LanguageService['getCompletionEntryDetails'],
): ts.LanguageService['getCompletionEntryDetails'] {
  return (...args) => {
    const details = getCompletionEntryDetails(...args)
    // modify import statement
    // @ts-expect-error ignore
    if (args[6]?.__isComponentAutoImport) {
      const { originalName, newName } =
        // @ts-expect-error ignore
        args[6]?.__isComponentAutoImport || {}
      for (const codeAction of details?.codeActions ?? []) {
        for (const change of codeAction.changes) {
          for (const textChange of change.textChanges) {
            textChange.newText = textChange.newText.replace(
              'import ' + originalName + ' from ',
              'import ' + newName + ' from ',
            )
          }
        }
      }
    }
    // @ts-expect-error ignore
    if (args[6]?.__isAutoImport) {
      // @ts-expect-error ignore
      const { fileName } = args[6]?.__isAutoImport || {}
      const sourceScript = language.scripts.get(asScriptId(fileName))
      if (sourceScript?.generated?.root instanceof MpxVirtualCode) {
        const sfc = sourceScript.generated.root.mpxSfc
        if (!sfc?.descriptor.script && !sfc?.descriptor.scriptSetup) {
          for (const codeAction of details?.codeActions ?? []) {
            for (const change of codeAction.changes) {
              for (const textChange of change.textChanges) {
                textChange.newText = `<script setup lang="ts">${textChange.newText}</script>\n\n`
                break
              }
              break
            }
            break
          }
        }
      }
    }
    return details
  }
}

function getCodeFixesAtPosition(
  getCodeFixesAtPosition: ts.LanguageService['getCodeFixesAtPosition'],
): ts.LanguageService['getCodeFixesAtPosition'] {
  return (...args) => {
    let result = getCodeFixesAtPosition(...args)
    // filter __VLS_
    result = result.filter(entry => !entry.description.includes('__VLS_'))
    return result
  }
}

function getDefinitionAndBoundSpan<T>(
  ts: typeof import('typescript'),
  language: Language<T>,
  languageService: ts.LanguageService,
  mpxOptions: MpxCompilerOptions,
  asScriptId: (fileName: string) => T,
  getDefinitionAndBoundSpan: ts.LanguageService['getDefinitionAndBoundSpan'],
): ts.LanguageService['getDefinitionAndBoundSpan'] {
  return (fileName, position) => {
    const result = getDefinitionAndBoundSpan(fileName, position)
    if (!result?.definitions?.length) {
      return result
    }

    const program = languageService.getProgram()!
    const sourceScript = language.scripts.get(asScriptId(fileName))
    if (!sourceScript?.generated) {
      return result
    }

    const root = sourceScript.generated.root
    if (!(root instanceof MpxVirtualCode)) {
      return result
    }

    if (
      !root.sfc.template ||
      position < root.sfc.template.startTagEnd ||
      position > root.sfc.template.endTagStart
    ) {
      return result
    }

    const definitions = new Set<ts.DefinitionInfo>(result.definitions)
    const skippedDefinitions: ts.DefinitionInfo[] = []

    if (result.definitions.length >= 2) {
      for (const definition of result.definitions) {
        if (
          root.sfc.content[definition.textSpan.start - 1] === '@' ||
          root.sfc.content.slice(
            definition.textSpan.start - 5,
            definition.textSpan.start,
          ) === 'v-on:'
        ) {
          skippedDefinitions.push(definition)
        }
      }
    }

    for (const definition of result.definitions) {
      if (
        mpxOptions.extensions.some(ext => definition.fileName.endsWith(ext))
      ) {
        continue
      }

      const sourceFile = program.getSourceFile(definition.fileName)
      if (!sourceFile) {
        continue
      }

      visit(sourceFile, definition, sourceFile)
    }

    for (const definition of skippedDefinitions) {
      definitions.delete(definition)
    }

    return {
      definitions: [...definitions],
      textSpan: result.textSpan,
    }

    function visit(
      node: ts.Node,
      definition: ts.DefinitionInfo,
      sourceFile: ts.SourceFile,
    ) {
      if (ts.isPropertySignature(node) && node.type) {
        proxy(node.name, node.type, definition, sourceFile)
      } else if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.type &&
        !node.initializer
      ) {
        proxy(node.name, node.type, definition, sourceFile)
      } else {
        ts.forEachChild(node, child => visit(child, definition, sourceFile))
      }
    }

    function proxy(
      name: ts.PropertyName,
      type: ts.TypeNode,
      definition: ts.DefinitionInfo,
      sourceFile: ts.SourceFile,
    ) {
      const { textSpan, fileName } = definition
      const start = name.getStart(sourceFile)
      const end = name.getEnd()

      if (start !== textSpan.start || end - start !== textSpan.length) {
        return
      }

      if (!ts.isIndexedAccessTypeNode(type)) {
        return
      }

      const pos = type.indexType.getStart(sourceFile)
      const res = getDefinitionAndBoundSpan(fileName, pos)
      if (res?.definitions?.length) {
        for (const definition of res.definitions) {
          definitions.add(definition)
        }
        skippedDefinitions.push(definition)
      }
    }
  }
}

function getQuickInfoAtPosition(
  ts: typeof import('typescript'),
  languageService: ts.LanguageService,
  getQuickInfoAtPosition: ts.LanguageService['getQuickInfoAtPosition'],
): ts.LanguageService['getQuickInfoAtPosition'] {
  return (...args) => {
    const result = getQuickInfoAtPosition(...args)
    if (
      result &&
      result.documentation?.length === 1 &&
      result.documentation[0].text.startsWith('__VLS_emit,')
    ) {
      const [_, emitVarName, eventName] =
        result.documentation[0].text.split(',')
      const program = languageService.getProgram()!
      const typeChecker = program.getTypeChecker()
      const sourceFile = program.getSourceFile(args[0])

      result.documentation = undefined

      let symbolNode: ts.Identifier | undefined

      sourceFile?.forEachChild(function visit(node) {
        if (ts.isIdentifier(node) && node.text === emitVarName) {
          symbolNode = node
        }
        if (symbolNode) {
          return
        }
        ts.forEachChild(node, visit)
      })

      if (symbolNode) {
        const emitSymbol = typeChecker.getSymbolAtLocation(symbolNode)
        if (emitSymbol) {
          const type = typeChecker.getTypeOfSymbolAtLocation(
            emitSymbol,
            symbolNode,
          )
          const calls = type.getCallSignatures()
          for (const call of calls) {
            const callEventName = (
              typeChecker.getTypeOfSymbolAtLocation(
                call.parameters[0],
                symbolNode,
              ) as ts.StringLiteralType
            ).value
            call.getJsDocTags()
            if (callEventName === eventName) {
              result.documentation = call.getDocumentationComment(typeChecker)
              result.tags = call.getJsDocTags()
            }
          }
        }
      }
    }
    return result
  }
}

function getEncodedSemanticClassifications<T>(
  ts: typeof import('typescript'),
  language: Language<T>,
  languageService: ts.LanguageService,
  asScriptId: (fileName: string) => T,
  getEncodedSemanticClassifications: ts.LanguageService['getEncodedSemanticClassifications'],
): ts.LanguageService['getEncodedSemanticClassifications'] {
  return (filePath, span, format) => {
    const fileName = filePath.replace(windowsPathReg, '/')
    const result = getEncodedSemanticClassifications(fileName, span, format)
    const sourceScript = language.scripts.get(asScriptId(fileName))
    const root = sourceScript?.generated?.root
    if (root instanceof MpxVirtualCode) {
      const { template } = root.sfc
      if (template) {
        for (const componentSpan of getComponentSpans.call(
          { typescript: ts, languageService },
          root,
          template,
          {
            start: span.start - template.startTagEnd,
            length: span.length,
          },
        )) {
          result.spans.push(
            componentSpan.start + template.startTagEnd,
            componentSpan.length,
            256, // class
          )
        }
      }
    }
    return result
  }
}

function getComponentSpans(
  this: Pick<RequestContext, 'typescript' | 'languageService'>,
  mpxCode: MpxVirtualCode,
  template: NonNullable<MpxVirtualCode['_sfc']['template']>,
  spanTemplateRange: ts.TextSpan,
) {
  const { typescript: ts, languageService } = this
  const result: ts.TextSpan[] = []
  const validComponentNames = _getComponentNames(ts, languageService, mpxCode)
  const elements = new Set(_getElementNames(ts, languageService, mpxCode))
  const components = new Set([
    ...validComponentNames,
    ...validComponentNames.map(hyphenateTag),
  ])
  if (template.ast) {
    for (const node of forEachElementNode(template.ast)) {
      if (
        node.loc.end.offset <= spanTemplateRange.start ||
        node.loc.start.offset >=
          spanTemplateRange.start + spanTemplateRange.length
      ) {
        continue
      }
      if (components.has(node.tag) && !elements.has(node.tag)) {
        let start = node.loc.start.offset
        if (template.lang === 'html') {
          start += '<'.length
        }
        result.push({
          start,
          length: node.tag.length,
        })
        if (template.lang === 'html' && !node.isSelfClosing) {
          result.push({
            start:
              node.loc.start.offset + node.loc.source.lastIndexOf(node.tag),
            length: node.tag.length,
          })
        }
      }
    }
  }
  return result
}
