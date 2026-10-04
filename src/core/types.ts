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
  /** Flow element name or Apex line reference. */
  via?: string;
  confidence: Confidence;
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
}

export interface ApexAnalysis {
  writes: Write[];
  reads: string[];
  classRefs: string[];
  loopIssues: LoopIssue[];
  unresolvedDml: number;
  /** Source with comments and string contents blanked out (same length/lines as original). */
  stripped: string;
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
  files: string[];
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
}
