export type NodeKind = "param" | "func" | "ram" | "frpage" | "unknown";
export type EdgeOrigin = "xref" | "scan" | "fr";
export type EdgeKind = "read" | "write" | "call" | "documented" | "documents";

export interface Axis {
  id: string;
  addr?: number;
  bits: number;
  signed: boolean;
  units?: string;
  math?: string;
  rows?: number;
  cols?: number;
  n?: number;
  labels?: string[];
  values?: number[] | number[][];
  error?: string;
}

export interface Statement {
  out: string;
  expr: string;
  guards: string[];
  reads: string[];
  calls: string[];
  interp: {
    helper: string;
    shape: "map" | "curve" | "table" | "filter";
    tables: string[];
    axes: string[];
  }[];
}

export interface GraphNode {
  id: string;
  t: NodeKind;
  name: string;
  /** param */
  kind?: "constant" | "curve" | "map";
  conf?: "documented" | "derived";
  cats?: number[];
  addr?: number;
  bank?: "master" | "slave";
  units?: string;
  math?: string;
  bits?: number;
  signed?: boolean;
  value?: number;
  raw?: number;
  desc?: { en?: string; ja?: string };
  axes?: Record<string, Axis>;
  error?: string;
  /** func */
  named?: boolean;
  size?: number;
  plate?: string;
  hasCode?: boolean;
  /** Formulas recovered from the decompiler; what the block computes. */
  stmts?: Statement[];
  /** frpage */
  section?: string;
  page?: number;
  dense?: boolean;
  excerpt?: string;
  count?: number;
  /** unknown */
  note?: string;
}

export interface GraphEdge {
  s: string;
  d: string;
  k: EdgeKind;
  o: EdgeOrigin;
}

export interface Category {
  id: number;
  de: string;
  en: string;
  ja?: string | null;
}

export interface FrDoc {
  section: string;
  de: string | null;
  en: string | null;
  ja?: string | null;
  pathDe: string | null;
  pathEn: string | null;
  pages: number;
}

export interface Coverage {
  params: number;
  paramsWithCodeReference: number;
  paramsWithCodeReferencePct: number;
  paramsPerBank: Record<string, number>;
  paramsWithCodeReferencePerBank: Record<string, number>;
  paramsInFunktionsrahmen: number;
  paramsInFunktionsrahmenPct: number;
  functions: number;
  namedFunctions: number;
  ramSymbols: number;
  frPages: number;
  densePagesExcludedFromBlocks: number;
  namesOnlyInDocuments: number;
  signalsMatchingRamSymbols: number;
  edgesByOrigin: Record<string, number>;
  edgesByKind: Record<string, number>;
  ghidraTargetsWithNoNode: number;
  decompiledFunctionFiles?: number;
  blocksWithFormulas?: number;
  tableLookupsFound?: number;
}

export interface Graph {
  meta: {
    docBase: string;
    xdf: string;
    xdfVersion: string;
    ghidra: Record<string, { languageID: string; createdWith: string; program: string }>;
    coverage: Coverage;
  };
  categories: Category[];
  frDocs: FrDoc[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  nameIndex: Record<string, string>;
  glossary: Record<string, string>;
}
