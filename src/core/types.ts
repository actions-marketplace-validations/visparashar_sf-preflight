// SPDX-License-Identifier: Apache-2.0
/**
 * Core data model for the org graph and analysis results.
 *
 * Salesforce API names are case-insensitive, so every map in OrgModel is keyed by
 * the lower-cased API name (see `key()` in util.ts). Definitions keep the original
 * spelling for display.
 */

export type ComponentType =
  | "CustomObject"
  | "CustomField"
  | "ValidationRule"
  | "ObjectChild"
  | "Flow"
  | "ApexTrigger"
  | "ApexClass"
  | "PermissionSet"
  | "Profile"
  | "AgentMetadata"
  | "WorkflowRule"
  | "Other";

export interface ComponentRef {
  type: ComponentType;
  /** Display name, e.g. `Opportunity.Contract_Signed_Date__c` or `AccountTrigger`. */
  name: string;
  /** Owning object for object-scoped components. */
  object?: string;
  /** Path relative to the project directory, posix separators. */
  file: string;
}

export type DmlOp = "insert" | "update" | "upsert" | "delete" | "undelete";
export type SaveEvent = "insert" | "update" | "delete" | "undelete";
export type Timing = "before" | "after";
export type Confidence = "high" | "medium" | "low";

/** A write performed by an automation (DML in Apex, Create/Update/Delete Records in a flow). */
export interface Write {
  object: string;
  op: DmlOp;
  fields?: string[];
  /** The automation writes back to the record that triggered it. */
  selfUpdate?: boolean;
  /** Field on the written object that is set to (or filtered by) the triggering record's Id. */
  linkField?: string;
  /** Flow element name or Apex line reference. */
  via?: string;
  confidence: Confidence;
}

/** A literal or reference value in flow metadata. */
export interface FlowValue {
  kind: "string" | "number" | "boolean" | "date" | "reference";
  value: string;
}

export interface FlowFilter {
  field: string;
  /** EqualTo, NotEqualTo, IsChanged, IsNull, GreaterThan, … */
  operator: string;
  value?: FlowValue;
}

export interface FieldDef {
  object: string;
  name: string;
  fullName: string;
  type?: string;
  formula?: string;
  /** Field API names referenced by a formula. */
  formulaRefs: string[];
  referenceTo: string[];
  /** `<required>true</required>` (master-detail fields are always required). */
  required?: boolean;
  defaultValue?: string;
  /** Roll-up summary: this field (on the parent) is recalculated when `childObject` records change. */
  summary?: {
    childObject: string;
    relationshipField: string;
    operation?: string;
    summarizedField?: string;
    filterFields: string[];
  };
  file: string;
}

export interface ObjectDef {
  name: string;
  file?: string;
  fields: Map<string, FieldDef>;
}

export interface ValidationRuleDef {
  object: string;
  name: string;
  fullName: string;
  active: boolean;
  formula: string;
  errorMessage?: string;
  /** Identifiers referenced by the formula (fields or relationship paths). */
  fieldRefs: string[];
  file: string;
}

export interface FlowTrigger {
  object: string;
  timing: Timing;
  events: SaveEvent[];
  /** Fields used in entry criteria. */
  entryFields: string[];
  /** Entry conditions; `filterLogic` is "and", "or", a custom expression or undefined. */
  filters: FlowFilter[];
  filterLogic?: string;
  /** Entry criteria written as a formula instead of filters. */
  filterFormula?: string;
  /** "Only when a record is updated to meet the condition requirements". */
  requiresChange?: boolean;
  hasScheduledPaths: boolean;
}

export interface FlowDef {
  name: string;
  label?: string;
  status: string;
  active: boolean;
  processType?: string;
  trigger?: FlowTrigger;
  writes: Write[];
  reads: string[];
  apexActions: string[];
  subflows: string[];
  /** `Object.Field` references found anywhere in the flow. */
  fieldRefs: string[];
  file: string;
}

export interface LoopIssue {
  kind: "soql-in-loop" | "dml-in-loop";
  line: number;
  snippet: string;
  /** Set when the DML/SOQL happens inside a method called from the loop, e.g. "AccountService.save". */
  via?: string;
}

/** A method call found in Apex source. */
export interface ApexCall {
  /** Target class; undefined for calls to the same class. */
  cls?: string;
  method: string;
  line: number;
  inLoop: boolean;
  /** Name of the calling method ("<trigger>" for trigger bodies). */
  from: string;
  snippet: string;
}

/** Per-method summary used for cross-method and cross-class analysis. */
export interface ApexMethod {
  name: string;
  line: number;
  invocable: boolean;
  isStatic?: boolean;
  /** Parameter types as written, e.g. ["List<Id>"]. */
  params?: string[];
  /** The method body itself contains DML / SOQL (not counting callees). */
  dml: boolean;
  soql: boolean;
}

export interface ApexAnalysis {
  writes: Write[];
  reads: string[];
  classRefs: string[];
  loopIssues: LoopIssue[];
  unresolvedDml: number;
  /** Source with comments and string contents blanked out (same length/lines as original). */
  stripped: string;
  /** "ast" when parsed with the Apex grammar; "heuristic" for the regex fallback. */
  parser?: "ast" | "heuristic";
  /** Syntax errors that forced the heuristic fallback. */
  parseErrors?: { line: number; message: string }[];
  /** AST only: method calls, method summaries and resolved field references. */
  calls?: ApexCall[];
  methods?: ApexMethod[];
  /** `Object.Field` references; `*.Field` when the object could not be resolved. */
  fieldRefs?: string[];
  /** `Object.Field` values assigned in code. */
  fieldWrites?: string[];
}

export interface ApexTriggerDef extends ApexAnalysis {
  name: string;
  object: string;
  events: { timing: Timing; event: SaveEvent }[];
  file: string;
}

export interface ApexClassDef extends ApexAnalysis {
  name: string;
  invocable: boolean;
  isTest: boolean;
  file: string;
}

export interface ObjectGrant {
  object: string;
  read: boolean;
  create: boolean;
  edit: boolean;
  delete: boolean;
  viewAll: boolean;
  modifyAll: boolean;
}

export interface FieldGrant {
  field: string;
  readable: boolean;
  editable: boolean;
}

export interface PermissionContainerDef {
  name: string;
  kind: "PermissionSet" | "Profile";
  objects: ObjectGrant[];
  fields: FieldGrant[];
  /** Enabled system permissions, e.g. ModifyAllData. */
  userPermissions: string[];
  file: string;
}

export interface OrgModel {
  projectDir: string;
  sourceRoots: string[];
  objects: Map<string, ObjectDef>;
  validationRules: ValidationRuleDef[];
  flows: Map<string, FlowDef>;
  triggers: Map<string, ApexTriggerDef>;
  classes: Map<string, ApexClassDef>;
  permissionContainers: Map<string, PermissionContainerDef>;
  /** Every metadata file found, keyed by relative path. */
  components: Map<string, ComponentRef>;
  warnings: string[];
  /** Present when the change was read from a git range. */
  provenance?: Provenance;
  /** Present when analyzed with `--org`: read-only context from a Salesforce org. */
  org?: OrgContext;
}

export interface OrgAutomation {
  kind: "Flow" | "ApexTrigger" | "ValidationRule";
  name: string;
  object: string;
  /** e.g. "after update", "before insert", "validation". */
  when: string[];
  namespace?: string;
  /** Installed package that owns it, when known. */
  packageName?: string;
}

export interface OrgContext {
  /** Org alias or username passed to `--org`. */
  org: string;
  queriedAt: string;
  /** Record counts for impacted objects. */
  recordCounts: Record<string, number>;
  /** Active users holding each changed permission set or profile. */
  assignments: { kind: "PermissionSet" | "Profile"; name: string; activeUsers: number }[];
  /** Active automation on impacted objects that exists in the org but not in the project. */
  orgOnlyAutomation: OrgAutomation[];
  packages: { namespace?: string; name: string; version: string }[];
  /** Queries that failed; the rest of the context is still usable. */
  errors: string[];
}

export interface CommitProvenance {
  sha: string;
  subject: string;
  author: string;
  /** AI tools detected from trailers, markers or bot authors; empty for human-only commits. */
  aiTools: string[];
}

export interface Provenance {
  range: string;
  commits: number;
  aiAssistedCommits: number;
  tools: string[];
  details: CommitProvenance[];
}

// ---------------------------------------------------------------------------
// Analysis results
// ---------------------------------------------------------------------------

export type ChangeType = "added" | "modified" | "deleted" | "renamed";

export interface Change {
  changeType: ChangeType;
  component: ComponentRef;
  previousFile?: string;
}

export type AutomationKind = "Flow" | "ApexTrigger" | "ApexClass" | "ValidationRule" | "RollUpSummary" | "Change";

export interface AutomationRef {
  kind: AutomationKind;
  name: string;
  file?: string;
  phase?: Phase;
}

export type Phase = "before-flow" | "before-trigger" | "validation" | "after-trigger" | "after-flow" | "rollup";

export interface SaveStep {
  order: number;
  phase: Phase;
  phaseLabel: string;
  automation: AutomationRef;
  writes: Write[];
  notes: string[];
}

export interface SaveProcedure {
  object: string;
  event: SaveEvent;
  steps: SaveStep[];
}

export interface CascadeNode {
  object: string;
  event: SaveEvent;
  via?: AutomationRef;
  depth: number;
  children: CascadeNode[];
  /** The object already appears earlier on this path: re-entry / recursion risk. */
  cycle?: boolean;
  truncated?: boolean;
}

export type Severity = "high" | "medium" | "low" | "info";

export interface Finding {
  rule: string;
  severity: Severity;
  title: string;
  detail: string;
  object?: string;
  /** Project-relative files involved; the first is the primary location. */
  files: string[];
  /** 1-based line in the primary file, when known. */
  line?: number;
}

export type TestKind =
  | "bulk"
  | "validation-collision"
  | "recursion"
  | "permission-negative"
  | "idempotency"
  | "boundary";

export interface SuggestedTest {
  kind: TestKind;
  object?: string;
  description: string;
  covers: string[];
}

export interface Reference {
  from: AutomationRef | { kind: "FormulaField" | "PermissionSet" | "Profile"; name: string; file?: string };
  to: string;
}

export interface AnalysisResult {
  schemaVersion: 1;
  generatedAt: string;
  projectDir: string;
  /** Project directory relative to the git root (posix, "" for the root); set when in a git repo. */
  projectPathInRepo?: string;
  base?: string;
  head?: string;
  changes: Change[];
  ignoredFiles: string[];
  references: Reference[];
  impactedObjects: string[];
  saveProcedures: SaveProcedure[];
  cascade: CascadeNode[];
  cycles: string[][];
  findings: Finding[];
  suggestedTests: SuggestedTest[];
  summary: {
    risk: "high" | "medium" | "low";
    changedComponents: number;
    impactedObjects: number;
    automationsInvolved: number;
    cycles: number;
    findingsBySeverity: Record<Severity, number>;
  };
  warnings: string[];
  /** Present when the change was read from a git range. */
  provenance?: Provenance;
  /** Present when analyzed with `--org`: read-only context from a Salesforce org. */
  org?: OrgContext;
}

export interface OrgAutomation {
  kind: "Flow" | "ApexTrigger" | "ValidationRule";
  name: string;
  object: string;
  /** e.g. "after update", "before insert", "validation". */
  when: string[];
  namespace?: string;
  /** Installed package that owns it, when known. */
  packageName?: string;
}

export interface OrgContext {
  /** Org alias or username passed to `--org`. */
  org: string;
  queriedAt: string;
  /** Record counts for impacted objects. */
  recordCounts: Record<string, number>;
  /** Active users holding each changed permission set or profile. */
  assignments: { kind: "PermissionSet" | "Profile"; name: string; activeUsers: number }[];
  /** Active automation on impacted objects that exists in the org but not in the project. */
  orgOnlyAutomation: OrgAutomation[];
  packages: { namespace?: string; name: string; version: string }[];
  /** Queries that failed; the rest of the context is still usable. */
  errors: string[];
}

export interface CommitProvenance {
  sha: string;
  subject: string;
  author: string;
  /** AI tools detected from trailers, markers or bot authors; empty for human-only commits. */
  aiTools: string[];
}

export interface Provenance {
  range: string;
  commits: number;
  aiAssistedCommits: number;
  tools: string[];
  details: CommitProvenance[];
}
