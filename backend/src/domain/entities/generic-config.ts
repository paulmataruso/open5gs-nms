import { YamlDocumentCommon } from './open5gs-yaml';

/**
 * What `loadGeneric()` actually produces for one NF: a handful of convenience
 * fields parsed out of the file, plus the whole parsed document.
 *
 * Every field here is optional because every one of them is absent from at
 * least one of the real files -- `loadGeneric` only fills a field when the
 * corresponding YAML section exists.
 *
 * `TDoc` is the document type of the specific file this came from. It is
 * supplied by the caller that NAMES the file (see `Open5gsConfigDocuments` in
 * domain/interfaces/config-repository.ts); a function taking a `string`
 * service name cannot know the shape, so that is the one place the mapping
 * is allowed to live.
 */
export interface GenericServiceConfig<TDoc extends YamlDocumentCommon = YamlDocumentCommon> {
  sbi?: { addr: string | string[]; port?: number };
  pfcp?: { addr: string; port?: number };
  gtpu?: { addr: string; port?: number };
  gtpc?: { addr: string; port?: number };
  ngap?: { addr: string | string[]; port?: number };
  nrf?: { sbi: { addr: string | string[]; port?: number } };
  logger?: { file?: string; level?: string };
  rawYaml?: TDoc;
}
