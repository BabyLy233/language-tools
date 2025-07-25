import type * as CompilerDOM from '@vue/compiler-dom'
import type { SFCBlock, SFCParseResult } from '@vue/compiler-sfc'
import type * as ts from 'typescript'
import type {
  MpxLanguagePluginReturn,
  Sfc,
  SfcBlock,
  SfcBlockAttr,
} from '../types'
import { computed, pauseTracking, resumeTracking } from 'alien-signals'
import { parseCssClassNames } from '../utils/parseCssClassNames'
import { parseCssVars } from '../utils/parseCssVars'
import { computedArray } from '../utils/signals'
import { parseUsingComponents } from '../utils/parseJsonUsingComponents'

export function computedSfc(
  ts: typeof import('typescript'),
  plugins: MpxLanguagePluginReturn[],
  fileName: string,
  getSnapshot: () => ts.IScriptSnapshot,
  getParseResult: () => SFCParseResult | undefined,
): Sfc {
  const getUntrackedSnapshot = () => {
    pauseTracking()
    const res = getSnapshot()
    resumeTracking()
    return res
  }
  const getContent = computed(() => {
    return getSnapshot().getText(0, getSnapshot().getLength())
  })
  const getComments = computed<string[]>(oldValue => {
    const newValue = getParseResult()?.descriptor.comments ?? []
    if (
      oldValue?.length === newValue.length &&
      oldValue?.every((v, i) => v === newValue[i])
    ) {
      return oldValue
    }
    return newValue
  })
  const getTemplate = computedNullableSfcBlock(
    'template',
    'html',
    computed(() => getParseResult()?.descriptor.template ?? undefined),
    (_block, base): NonNullable<Sfc['template']> => {
      const compiledAst = computedTemplateAst(base)
      return mergeObject(base, {
        get ast() {
          return compiledAst()?.ast
        },
        get errors() {
          return compiledAst()?.errors
        },
        get warnings() {
          return compiledAst()?.warnings
        },
      })
    },
  )
  const getScript = computedNullableSfcBlock(
    'script',
    'js',
    computed(() => getParseResult()?.descriptor.script ?? undefined),
    (block, base): NonNullable<Sfc['script']> => {
      const getSrc = computedAttrValue('__src', base, block)
      const getAst = computed(() => {
        for (const plugin of plugins) {
          const ast = plugin.compileSFCScript?.(base.lang, base.content)
          if (ast) {
            return ast
          }
        }
        return ts.createSourceFile(
          fileName + '.' + base.lang,
          '',
          99 satisfies ts.ScriptTarget.Latest,
        )
      })
      return mergeObject(base, {
        get src() {
          return getSrc()
        },
        get ast() {
          return getAst()
        },
      })
    },
  )
  const getOriginalScriptSetup = computedNullableSfcBlock(
    'scriptSetup',
    'js',
    computed(() => getParseResult()?.descriptor.scriptSetup ?? undefined),
    (_, base): NonNullable<Sfc['scriptSetup']> => {
      const getAst = computed(() => {
        for (const plugin of plugins) {
          const ast = plugin.compileSFCScript?.(base.lang, base.content)
          if (ast) {
            return ast
          }
        }
        return ts.createSourceFile(
          fileName + '.' + base.lang,
          '',
          99 satisfies ts.ScriptTarget.Latest,
        )
      })
      return mergeObject(base, {
        get ast() {
          return getAst()
        },
      })
    },
  )
  const getJson = computedNullableSfcBlock(
    'json',
    'json',
    computed(() => getParseResult()?.descriptor.json ?? undefined),
    (_, base): NonNullable<Sfc['json']> => {
      const getAst = computed(() => {
        const lang = base.lang ?? 'json'
        for (const plugin of plugins) {
          const ast = plugin.compileSFCJson?.(lang, base.content)
          if (ast) {
            return ast
          }
        }
        return ts.createSourceFile('', '', 100 satisfies ts.ScriptTarget.JSON)
      })
      const getUsingComponents = computed(() =>
        parseUsingComponents(ts, getAst(), base.lang),
      )
      const getResolvedUsingComponents = computed(() => {
        for (const plugin of plugins) {
          if (typeof plugin.resolveUsingComponentsPath === 'function') {
            return plugin.resolveUsingComponentsPath(
              getUsingComponents(),
              fileName,
            )
          }
        }
      })
      return mergeObject(base, {
        get ast() {
          return getAst()
        },
        get usingComponents() {
          return getUsingComponents()
        },
        get resolveUsingComponents() {
          return getResolvedUsingComponents()
        },
      } satisfies Partial<Sfc['json']>)
    },
  )
  const hasScript = computed(() => !!getParseResult()?.descriptor.script)
  const hasScriptSetup = computed(
    () => !!getParseResult()?.descriptor.scriptSetup,
  )
  const getScriptSetup = computed(() => {
    if (!hasScript() && !hasScriptSetup()) {
      return {
        content: '',
        lang: 'ts',
        name: '',
        start: 0,
        end: 0,
        startTagEnd: 0,
        endTagStart: 0,
        genericOffset: 0,
        attrs: {},
        ast: ts.createSourceFile(
          '',
          '',
          99 satisfies ts.ScriptTarget.Latest,
          false,
          ts.ScriptKind.TS,
        ),
      }
    }
    return getOriginalScriptSetup()
  })
  const styles = computedArray(
    computed(() => getParseResult()?.descriptor.styles ?? []),
    (getBlock, i) => {
      const base = computedSfcBlock('style_' + i, 'css', getBlock)
      const getModule = computedAttrValue('__module', base, getBlock)
      const getScoped = computed(() => !!getBlock().scoped)
      const getCssVars = computed(() => [...parseCssVars(base.content)])
      const getClassNames = computed(() => [
        ...parseCssClassNames(base.content),
      ])
      return () =>
        mergeObject(base, {
          get module() {
            return getModule()
          },
          get scoped() {
            return getScoped()
          },
          get cssVars() {
            return getCssVars()
          },
          get classNames() {
            return getClassNames()
          },
        }) satisfies Sfc['styles'][number]
    },
  )
  const customBlocks = computedArray(
    computed(() => getParseResult()?.descriptor.customBlocks ?? []),
    (getBlock, i) => {
      const base = computedSfcBlock('custom_block_' + i, 'txt', getBlock)
      const getType = computed(() => getBlock().type)
      return () =>
        mergeObject(base, {
          get type() {
            return getType()
          },
        }) satisfies Sfc['customBlocks'][number]
    },
  )

  return {
    get content() {
      return getContent()
    },
    get comments() {
      return getComments()
    },
    get template() {
      return getTemplate()
    },
    get script() {
      return getScript()
    },
    get scriptSetup() {
      return getScriptSetup()
    },
    get json() {
      return getJson()
    },
    get styles() {
      return styles
    },
    get customBlocks() {
      return customBlocks
    },
  }

  function computedTemplateAst(base: SfcBlock) {
    let cache:
      | {
          template: string
          snapshot: ts.IScriptSnapshot
          result: CompilerDOM.CodegenResult
          plugin: MpxLanguagePluginReturn
        }
      | undefined

    return computed(() => {
      if (cache?.template === base.content) {
        return {
          errors: [],
          warnings: [],
          ast: cache?.result.ast,
        }
      }

      // incremental update
      if (cache?.plugin.updateSFCTemplate) {
        const change = getUntrackedSnapshot().getChangeRange(cache.snapshot)
        if (change) {
          pauseTracking()
          const templateOffset = base.startTagEnd
          resumeTracking()

          const newText = getUntrackedSnapshot().getText(
            change.span.start,
            change.span.start + change.newLength,
          )
          const newResult = cache.plugin.updateSFCTemplate(cache.result, {
            start: change.span.start - templateOffset,
            end: change.span.start + change.span.length - templateOffset,
            newText,
          })
          if (newResult) {
            cache.template = base.content
            cache.snapshot = getUntrackedSnapshot()
            cache.result = newResult
            return {
              errors: [],
              warnings: [],
              ast: newResult.ast,
            }
          }
        }
      }

      const errors: CompilerDOM.CompilerError[] = []
      const warnings: CompilerDOM.CompilerError[] = []
      let options: CompilerDOM.CompilerOptions = {
        onError: (err: CompilerDOM.CompilerError) => {
          filterErrors(err, errors)
        },
        onWarn: (err: CompilerDOM.CompilerError) => {
          filterErrors(err, warnings)
        },
        expressionPlugins: ['typescript'],
      }

      for (const plugin of plugins) {
        if (plugin.resolveTemplateCompilerOptions) {
          options = plugin.resolveTemplateCompilerOptions(options)
        }
      }

      for (const plugin of plugins) {
        let result: CompilerDOM.CodegenResult | undefined

        try {
          result = plugin.compileSFCTemplate?.(base.lang, base.content, options)
        } catch (e) {
          const err = e as CompilerDOM.CompilerError
          errors.push(err)
        }

        if (result || errors.length) {
          if (result && !errors.length && !warnings.length) {
            cache = {
              template: base.content,
              snapshot: getUntrackedSnapshot(),
              result: result,
              plugin,
            }
          } else {
            cache = undefined
          }

          return {
            errors,
            warnings,
            ast: result?.ast,
          }
        }
      }

      return {
        errors,
        warnings,
        ast: undefined,
      }
    })
  }

  function computedNullableSfcBlock<T extends SFCBlock, K extends SfcBlock>(
    name: string,
    defaultLang: string,
    getBlock: () => T | undefined,
    resolve: (block: () => T, base: SfcBlock) => K,
  ) {
    const hasBlock = computed(() => !!getBlock())
    return computed<K | undefined>(() => {
      if (!hasBlock()) {
        return
      }
      const _block = computed(() => getBlock()!)
      return resolve(_block, computedSfcBlock(name, defaultLang, _block))
    })
  }

  function computedSfcBlock<T extends SFCBlock>(
    name: string,
    defaultLang: string,
    getBlock: () => T,
  ) {
    const getLang = computed(() => getBlock().lang ?? defaultLang)
    const getAttrs = computed(() => getBlock().attrs)
    const getContent = computed(() => getBlock().content)
    const getStartTagEnd = computed(() => getBlock().loc.start.offset)
    const getEndTagStart = computed(() => getBlock().loc.end.offset)
    const getStart = computed(() =>
      getUntrackedSnapshot()
        .getText(0, getStartTagEnd())
        .lastIndexOf('<' + getBlock().type),
    )
    const getEnd = computed(
      () =>
        getEndTagStart() +
        getUntrackedSnapshot()
          .getText(getEndTagStart(), getUntrackedSnapshot().getLength())
          .indexOf('>') +
        1,
    )
    return {
      name,
      get lang() {
        return getLang()
      },
      get attrs() {
        return getAttrs()
      },
      get content() {
        return getContent()
      },
      get startTagEnd() {
        return getStartTagEnd()
      },
      get endTagStart() {
        return getEndTagStart()
      },
      get start() {
        return getStart()
      },
      get end() {
        return getEnd()
      },
    }
  }

  function computedAttrValue<T extends SFCBlock>(
    key: keyof T & string,
    base: ReturnType<typeof computedSfcBlock>,
    getBlock: () => T,
  ) {
    return computed(() => {
      const val = getBlock()[key] as SfcBlockAttr | undefined
      if (typeof val === 'object') {
        return {
          ...val,
          offset: base.start + val.offset,
        }
      }
      return val
    })
  }
}

function mergeObject<T, K>(a: T, b: K): T & K {
  return Object.defineProperties(a, Object.getOwnPropertyDescriptors(b)) as T &
    K
}

/**
 * 过滤 Vue compiler-core 编译时检测的 Vue 强相关 Errors
 * 根据 Vue 错误码（https://github.com/vuejs/core/blob/main/packages/compiler-core/src/errors.ts#L155）
 * 发现：
 * - 0 ~ 24 的错误码是比较通用的模板编译错误可以保留，
 * - > 24 的错误码是 Vue 强相关的错误，需要过滤。
 * Mpx 模板编译转换的错误码从 1000 开始递增，避免与 Vue 的错误码冲突。
 */
function filterErrors(
  error: CompilerDOM.CompilerError,
  errors: CompilerDOM.CompilerError[],
) {
  if (error.code && +error.code > 24 && +error.code < 1000) {
    return
  }
  errors.push(error)
}
