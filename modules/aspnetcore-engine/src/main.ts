import { Type, NgModuleFactory, CompilerFactory, Compiler, ApplicationRef, StaticProvider } from '@angular/core';
import { platformDynamicServer, PlatformState, INITIAL_CONFIG, platformServer, BEFORE_APP_SERIALIZED } from '@angular/platform-server';
import { ResourceLoader } from '@angular/compiler';

import { REQUEST, ORIGIN_URL } from './tokens';
import { FileLoader } from './file-loader';

import { IEngineOptions } from './interfaces/engine-options';

import { filter } from 'rxjs/operator/filter';
import { first } from 'rxjs/operator/first';
import { toPromise } from 'rxjs/operator/toPromise';

/* @internal */
export class UniversalData {
  public appNode = '';
  public title = '';
  public scripts = '';
  public styles = '';
  public meta = '';
  public links = '';
}

/* @internal */
let appSelector = 'app-root'; // default

/* @internal */
export function _getUniversalData(
  doc: any /* TODO: type definition for Domino - DomAPI Spec (similar to "Document") */
): UniversalData {

  const STYLES = [];
  const SCRIPTS = [];
  const META = [];
  const LINKS = [];

  for (let i = 0; i < doc.head.children.length; i++) {
    const element = doc.head.children[i];
    const tagName = element.tagName.toUpperCase();

    switch (tagName) {
      case 'SCRIPT':
        SCRIPTS.push(element.outerHTML);
        break;
      case 'STYLE':
        STYLES.push(element.outerHTML);
        break;
      case 'LINK':
        LINKS.push(element.outerHTML);
        break;
      case 'META':
        META.push(element.outerHTML);
        break;
      default:
        break;
    }
  }

  // ServerTransferStateModule.serializeTransferStateFactory() appends to body
  for (let i = 0; i < doc.body.children.length; i++) {
    const element: Element = doc.body.children[i];
    const tagName = element.tagName.toUpperCase();

    switch (tagName) {
      case 'SCRIPT':
        SCRIPTS.push(element.outerHTML);
        break;
      case 'STYLE':
        STYLES.push(element.outerHTML);
        break;
      case 'LINK':
        LINKS.push(element.outerHTML);
        break;
      case 'META':
        META.push(element.outerHTML);
        break;
      default:
        break;
    }
  }

  return {
    title: doc.title,
    appNode: doc.querySelector(appSelector).outerHTML,
    scripts: SCRIPTS.join('\n'),
    styles: STYLES.join('\n'),
    meta: META.join('\n'),
    links: LINKS.join('\n')
  };
};

/* @internal */
export interface PlatformOptions {
  document?: string;
  url?: string;
  extraProviders?: StaticProvider[];
}

/**
 * renderModuleFactory2 returns a Domino document
 * @param moduleFactory
 * @param options
 * @returns Domino type document TODO: type definition for Domino - DomAPI Spec (similar to "Document")
 */
export function renderModuleFactory2<T>(
  moduleFactory: NgModuleFactory<T>, options: PlatformOptions): Promise<any> {

  const extraProviders = options.extraProviders ? options.extraProviders : [];

  const platform = platformServer([
    { provide: INITIAL_CONFIG, useValue: { document: options.document, url: options.url } },
    extraProviders
  ]);

  return platform.bootstrapModuleFactory(moduleFactory).then((moduleRef) => {

    const applicationRef: ApplicationRef = moduleRef.injector.get(ApplicationRef);

    return toPromise
      .call(first.call(filter.call(applicationRef.isStable, (isStable: boolean) => isStable)))
      .then(() => {

        // Run any BEFORE_APP_SERIALIZED callbacks just before rendering to string.
        const callbacks = moduleRef.injector.get(BEFORE_APP_SERIALIZED, null);
        if (callbacks) {
          for (const callback of callbacks) {
            try {
              callback();
            } catch (e) {
              // Ignore exceptions.
              console.warn('Ignoring BEFORE_APP_SERIALIZED Exception: ', e);
            }
          }
        }
        const state: PlatformState = platform.injector.get(PlatformState);
        const output = state.getDocument();
        platform.destroy();
        return output;
      });
  });
}

export function ngAspnetCoreEngine(
  options: IEngineOptions
): Promise<{ html: string, globals: { styles: string, title: string, meta: string, transferData?: {}, [key: string]: any } }> {

  if (!options.appSelector) {
    throw new Error(`appSelector is required! Pass in " appSelector: '<app-root></app-root>' ", for your root App component.`);
  }

  // Grab the DOM "selector" from the passed in Template <app-root> for example = "app-root"
  appSelector = options.appSelector.substring(1, options.appSelector.indexOf('>'));

  const compilerFactory: CompilerFactory = platformDynamicServer().injector.get(CompilerFactory);
  const compiler: Compiler = compilerFactory.createCompiler([
    {
      providers: [
        { provide: ResourceLoader, useClass: FileLoader, deps: [] }
      ]
    }
  ]);

  return new Promise((resolve, reject) => {

    try {
      const moduleOrFactory = options.ngModule;
      if (!moduleOrFactory) {
        throw new Error('You must pass in a NgModule or NgModuleFactory to be bootstrapped');
      }

      options.providers = options.providers || [];

      const extraProviders: StaticProvider[] = options.providers.concat(
        ...options.providers,
        [{
          provide: ORIGIN_URL,
          useValue: options.request.origin
        }, {
          provide: REQUEST,
          useValue: options.request.data.request
        }
        ]
      );

      getFactory(moduleOrFactory, compiler)
        .then(factory => {
          return renderModuleFactory2(factory, {
            document: options.appSelector,
            url: options.request.url,
            extraProviders: extraProviders
          });
        })
        .then(doc => {

          const universalData = _getUniversalData(doc);

          resolve({
            html: universalData.appNode,
            globals: {
              styles: universalData.styles,
              title: universalData.title,
              scripts: universalData.scripts,
              meta: universalData.meta,
              links: universalData.links
            }

          });
        }, (err) => {
          reject(err);
        });

    } catch (ex) {
      reject(ex);
    }

  });

}

/* @internal */
const factoryCacheMap = new Map<Type<{}>, NgModuleFactory<{}>>();
function getFactory(
  moduleOrFactory: Type<{}> | NgModuleFactory<{}>, compiler: Compiler
): Promise<NgModuleFactory<{}>> {

  return new Promise<NgModuleFactory<{}>>((resolve, reject) => {
    // If module has been compiled AoT
    if (moduleOrFactory instanceof NgModuleFactory) {
      resolve(moduleOrFactory);
      return;
    } else {
      let moduleFactory = factoryCacheMap.get(moduleOrFactory);

      // If module factory is cached
      if (moduleFactory) {
        resolve(moduleFactory);
        return;
      }

      // Compile the module and cache it
      compiler.compileModuleAsync(moduleOrFactory)
        .then((factory) => {
          factoryCacheMap.set(moduleOrFactory, factory);
          resolve(factory);
        }, (err => {
          reject(err);
        }));
    }
  });
}