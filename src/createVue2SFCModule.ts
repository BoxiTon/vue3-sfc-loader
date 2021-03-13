// compiler-sfc src: https://github.com/vuejs/vue-next/blob/master/packages/compiler-sfc/src/index.ts#L1
import {
	compileStyleAsync as sfc_compileStyleAsync,
	compileTemplate as sfc_compileTemplate,
	parse as sfc_parse, StyleCompileOptions,
} from '@vue/component-compiler-utils'

import * as vueTemplateCompiler from 'vue-template-compiler'
import { VueTemplateCompiler } from '@vue/component-compiler-utils/dist/types'
import { TemplateCompileOptions } from '@vue/component-compiler-utils/dist/compileTemplate'


import {
	parse as babel_parse,
	ParserPlugin as babel_ParserPlugin
} from '@babel/parser';

import {
	transformFromAstAsync as babel_transformFromAstAsync,
	types as t,
} from '@babel/core';

// @ts-ignore (Could not find a declaration file for module '@babel/plugin-transform-modules-commonjs')
import babelPluginTransformModulesCommonjs from '@babel/plugin-transform-modules-commonjs'


import {
	formatError,
	formatErrorStartEnd,
	withCache,
	hash,
	renameDynamicImport,
	parseDeps,
	interopRequireDefault,
	transformJSCode,
	loadDeps,
	createModule,
	formatErrorLineColumn
} from './tools'

import {
	Options,
	LoadModule,
	ModuleExport,
	CustomBlockCallback
} from './types'

import {
	processors,
	StylePreprocessor,
	StylePreprocessorResults
} from '../build/vue2StyleProcessors'

export { version as vueVersion } from 'vue-template-compiler/../../package.json'


/**
 * the version of the library (process.env.VERSION is set by webpack, at compile-time)
 */
const version : string = process.env.VERSION;

const genSourcemap : boolean = !!process.env.GEN_SOURCEMAP;

/**
 * @internal
 */
const isProd : boolean = process.env.NODE_ENV === 'production';



/**
 * @internal
 */

export async function createSFCModule(source : string, filename : string, options : Options, loadModule : LoadModule) : Promise<ModuleExport> {

	const component = {};


	const { delimiters, moduleCache, compiledCache, pathHandlers: { resolve }, getFile, addStyle, log, additionalBabelPlugins = [], customBlockHandler } = options;

	// vue-loader next: https://github.com/vuejs/vue-loader/blob/next/src/index.ts#L91
	const descriptor = sfc_parse({
		source,
		filename,
		needMap: genSourcemap,
		compiler: vueTemplateCompiler as VueTemplateCompiler}
		);

	const customBlockCallbacks : CustomBlockCallback[] = customBlockHandler !== undefined ? await Promise.all( descriptor.customBlocks.map((block ) => customBlockHandler(block, filename, options)) ) : [];

	const componentHash = hash(filename, version);
	const scopeId = `data-v-${componentHash}`;

	// hack: asynchronously preloads the language processor before it is required by the synchronous preprocessCustomRequire() callback, see below
	if ( descriptor.template && descriptor.template.lang )
		await loadModule(descriptor.template.lang, options);


	const hasScoped = descriptor.styles.some(e => e.scoped);

	// https://github.com/vuejs/vue-loader/blob/b53ae44e4b9958db290f5918248071e9d2445d38/lib/runtime/componentNormalizer.js#L36
	if (hasScoped) {
		Object.assign(component, {_scopeId: scopeId});
	}

	const compileTemplateOptions : TemplateCompileOptions = descriptor.template ? {
		// hack, since sourceMap is not configurable an we want to get rid of source-map dependency. see genSourcemap
		source: descriptor.template.src ? (await getFile(resolve(filename, descriptor.template.src))).content : descriptor.template.content,
		filename,
		compiler: vueTemplateCompiler as VueTemplateCompiler,
		compilerOptions: {
			delimiters,
			outputSourceRange: true,
			scopeId: hasScoped ? scopeId : null,
			comments: true
		} as any,
		isProduction: isProd,
		prettify: false
	} : null;

	// Vue2 doesn't support preprocessCustomRequire, so we have to preprocess manually
	if (descriptor.template?.lang) {
		const preprocess = moduleCache[descriptor.template.lang] as any;
		compileTemplateOptions.source = await withCache(compiledCache, [ compileTemplateOptions.source, descriptor.template.lang ], async ({ preventCache }) => {

			return await new Promise((resolve, reject) => {
				preprocess.render(compileTemplateOptions.source, compileTemplateOptions.preprocessOptions, (_err : any, _res : any) => {

					if (_err)
						reject(_err)
					else
						resolve(_res)
				})
			})

		});
	}

	if ( descriptor.script ) {

		// eg: https://github.com/vuejs/vue-loader/blob/v15.9.6/lib/index.js

		const src = descriptor.script.src ? (await getFile(resolve(filename, descriptor.script.src))).content : descriptor.script.content;

		const [ depsList, transformedScriptSource ] = await withCache(compiledCache, [ componentHash, src ], async ({ preventCache }) => {

			const babelParserPlugins : babel_ParserPlugin[] = [];

			let ast: t.File
			try {
				ast = babel_parse(src, {
					// doc: https://babeljs.io/docs/en/babel-parser#options
					// if: https://github.com/babel/babel/blob/main/packages/babel-parser/typings/babel-parser.d.ts#L24
					plugins: [
						...babelParserPlugins
					],
					sourceType: 'module',
					sourceFilename: filename
				});

			} catch(ex) {
				log?.('error', 'SFC script', formatErrorLineColumn(ex.message, filename, source, ex.loc.line, ex.loc.column + 1) );
				throw ex;
			}

			renameDynamicImport(ast);
			const depsList = parseDeps(ast);

			// doc: https://babeljs.io/docs/en/babel-core#transformfromastasync
			const transformedScript = await babel_transformFromAstAsync(ast, src, {
				sourceMaps: genSourcemap, // https://babeljs.io/docs/en/options#sourcemaps
				plugins: [ // https://babeljs.io/docs/en/options#plugins
					babelPluginTransformModulesCommonjs, // https://babeljs.io/docs/en/babel-plugin-transform-modules-commonjs#options
					...additionalBabelPlugins,
				],
				babelrc: false,
				configFile: false,
				highlightCode: false,
			});

			return [ depsList, transformedScript.code ];
		});

		await loadDeps(filename, depsList, options, loadModule);
		Object.assign(component, interopRequireDefault(createModule(filename, transformedScriptSource, options, loadModule).exports).default);
	}


	if ( descriptor.template !== null ) {
		// compiler-sfc src: https://github.com/vuejs/vue-next/blob/15baaf14f025f6b1d46174c9713a2ec517741d0d/packages/compiler-sfc/src/compileTemplate.ts#L39
		// compileTemplate eg: https://github.com/vuejs/vue-loader/blob/next/src/templateLoader.ts#L33
		const [ templateDepsList, templateTransformedSource ] = await withCache(compiledCache, [ componentHash, compileTemplateOptions.source ], async ({ preventCache }) => {

			const template = sfc_compileTemplate(compileTemplateOptions);
			// "@vue/component-compiler-utils" does NOT assume any module system, and expose render in global scope.
			template.code += `\nmodule.exports = { render, staticRenderFns }`

			if ( template.errors.length ) {

				preventCache();
				for ( let err of template.errors ) {
					if (typeof err !== 'object') {
						err = {
							msg: err,
							start: undefined,
							end: undefined
						}
					}

					log?.('error', 'SFC template', formatErrorStartEnd(err.msg, filename, compileTemplateOptions.source.trim(), err.start, err.end ));
				}
			}

			for ( let err of template.tips ) {
				if (typeof err !== 'object') {
					err = {
						msg: err,
						start: undefined,
						end: undefined
					}
				}

				log?.('info', 'SFC template', formatErrorStartEnd(err.msg, filename, source, err.start, err.end ));
			}

			return await transformJSCode(template.code, true, filename, options);
		});

		await loadDeps(filename, templateDepsList, options, loadModule);
		Object.assign(component, createModule(filename, templateTransformedSource, options, loadModule).exports);
	}


	for ( const descStyle of descriptor.styles ) {

		const src = descStyle.src ? (await getFile(resolve(filename, descStyle.src))).content : descStyle.content;

		const style = await withCache(compiledCache, [ componentHash, src, descStyle.lang ], async ({ preventCache }) => {
			// src: https://github.com/vuejs/vue-next/blob/15baaf14f025f6b1d46174c9713a2ec517741d0d/packages/compiler-sfc/src/compileStyle.ts#L70

			const compileStyleOptions: StyleCompileOptions = {
				source: src,
				filename,
				id: scopeId,
				scoped: descStyle.scoped,
				trim: false,
				preprocessLang: descStyle.lang,
				preprocessOptions: {
					preprocessOptions: {
						customRequire: (id: string) => moduleCache[id]
					}
				}
			}

			// Vue2 doesn't support preprocessCustomRequire, so we have to preprocess manually
			if ( descStyle.lang && processors[descStyle.lang] === undefined )
				processors[descStyle.lang] = await loadModule(descStyle.lang, options) as StylePreprocessor;

			const compiledStyle = await sfc_compileStyleAsync(compileStyleOptions);
			if ( compiledStyle.errors.length ) {

				preventCache();
				for ( const err of compiledStyle.errors ) {

					log?.('error', 'SFC style', formatError(err, filename, source));
				}
			}

			return compiledStyle.code;
		});

		addStyle(style, descStyle.scoped ? scopeId : undefined);
	}

	if ( customBlockHandler !== undefined )
		await Promise.all(customBlockCallbacks.map(cb => cb?.(component)));

	return component;
}