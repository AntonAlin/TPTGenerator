/**
 * Types for the machine-readable TPT specification.
 *
 * The JSON that satisfies these types is GENERATED from the official FinDatEx
 * Excel template by `scripts/build-spec.ts`. Never edit the JSON by hand and
 * never hard-code field definitions elsewhere in the app: read them from the
 * spec so a new TPT version can be dropped in by replacing the template.
 */

/** Requirement level as published in the template's "M / C / O / I / N/A" column. */
export type Requirement =
  | 'mandatory'
  | 'conditional'
  | 'optional'
  | 'indicative'
  | 'not_applicable'
  | 'unknown';

/**
 * Data type inferred from the CODIFICATION text of the template.
 * The template does not have a dedicated "data type" column, so this is
 * a deterministic, rule-based reading of the official text. The raw text is
 * always kept in `codification` and `dataTypeRule` says which rule matched.
 */
export type DataType =
  | 'date'
  | 'number'
  | 'integer'
  | 'string'
  | 'currency'
  | 'country'
  | 'cic'
  | 'nace'
  | 'code'
  | 'unknown';

export interface CodeListEntry {
  code: string;
  label: string;
}

export interface SpecField {
  /** Field id exactly as numbered in the template, e.g. "12", "8b", "105a", "1000". */
  id: string;
  /** Numeric part of the id, used for ordering checks. */
  number: number;
  /** Letter suffix ("b" in "8b"), empty string if none. */
  suffix: string;
  /** Column header exactly as it must appear in the exported TPT file. */
  header: string;
  /** Human-readable name derived from the header (underscores → spaces). */
  name: string;
  /** Section heading of the template this field sits under. */
  section: string;
  /** 0-based position of the field in the export column order. */
  order: number;
  definition: string;
  codification: string;
  comment: string;
  xpath: string;
  /** Raw requirement code as published, e.g. "M", "C", "N/A". */
  requirementRaw: string;
  requirement: Requirement;
  dataType: DataType;
  /** Name of the inference rule that produced `dataType` (for audit). */
  dataTypeRule: string;
  /** Maximum length if stated in the codification (e.g. "Alphanum (max 255)"). */
  maxLength?: number;
  /** Closed list parsed from the codification, when the text contains one. */
  codeList?: CodeListEntry[];
  /** Whether the closed list was found in the CODIFICATION or the COMMENT column. */
  codeListSource?: 'codification' | 'comment';
  /** Non-ISO codes the template explicitly allows in addition to ISO lists (e.g. CNH for currencies). */
  additionalCodes?: CodeListEntry[];
  /**
   * Applicability per CIC category column of the template (keys "0".."9","A".."F").
   * Values are the raw marks, e.g. "x", "M", "C". Absent key = blank cell.
   */
  cicApplicability: Record<string, string>;
  /** Marks in the additional-regime columns (NW 675, SST, IORP), raw. */
  otherRegimes: Record<string, string>;
  /** True if the template highlights this field as changed vs. the previous version. */
  changedFromPreviousVersion: boolean;
  /** True if FinDatEx says the field is retained only for technical reasons and must be left empty. */
  mustBeEmpty: boolean;
}

export interface SpecMeta {
  /** e.g. "V8.0" */
  version: string;
  /** Exact value required in the version field (field 1000). */
  versionFieldValue: string;
  /** Version id used in the file naming convention, e.g. "V8". */
  fileNameVersionTag: string;
  /** File naming convention text from the template. */
  fileNamingConvention: string;
  title: string;
  dateLine: string;
  sourceFile: string;
  sourceSha256: string;
  /** Sources of any metadata that did not come from the Excel template itself. */
  supplementarySources: string[];
  generatedBy: string;
}

export interface TptSpec {
  meta: SpecMeta;
  sections: string[];
  fields: SpecField[];
  /** Messages produced during parsing that a maintainer should review. */
  warnings: string[];
}
