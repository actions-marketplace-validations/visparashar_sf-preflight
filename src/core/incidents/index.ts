// SPDX-License-Identifier: Apache-2.0
import path from "node:path";
import { createSfRunner, type SfRunner } from "../org/sf.js";
import { loadProject } from "../project.js";
import { mergeVocabulary, vocabularyFromModel } from "./classify.js";
import { collectIncidents, componentDatesInOrg, type IncidentSource } from "./collect.js";
import { historyVocabulary, type IncidentReport, recentChanges, traceIncidents } from "./trace.js";

export interface InvestigateOptions {
  projectDir: string;
  /** Read errors from this org (read-only). Optional when errors are imported. */
  org?: string;
  /** Start of the error window. */
  since: Date;
  /** Branch whose history to search (default HEAD). */
  ref?: string;
  /** Most recent changes to consider (default 50). */
  maxChanges?: number;
  /** How many days before the error window to look for changes (default 30). */
  lookbackDays?: number;
  /** Errors from a JSON file (see importErrors). */
  errors?: { raw: unknown; file: string };
  sources?: Exclude<IncidentSource, "imported">[];
  runner?: SfRunner;
}

/** Read production errors and trace each one back to the recent changes most likely to have caused it. */
export function investigateIncidents(opts: InvestigateOptions): IncidentReport {
  if (!opts.org && !opts.errors)
    throw new Error("Provide --org <alias> to read errors from an org, or --errors <file>.");
  const projectDir = path.resolve(opts.projectDir);
  const model = loadProject(projectDir);
  const historySince = new Date(opts.since.getTime() - (opts.lookbackDays ?? 30) * 86_400_000);
  const history = recentChanges(projectDir, { ref: opts.ref, since: historySince, max: opts.maxChanges });
  const vocab = mergeVocabulary(vocabularyFromModel(model), historyVocabulary(projectDir, history.changes));
  const runner = opts.org ? (opts.runner ?? createSfRunner({ timeoutMs: 300_000 })) : undefined;
  const collection = collectIncidents({
    model,
    vocab,
    since: opts.since,
    org: opts.org,
    runner,
    sources: opts.sources,
    imported: opts.errors,
  });
  const report = traceIncidents({ model, collection, history, projectDir });
  if (!opts.org) return report;
  // When the suspected components changed in the org sharpens the timing.
  const components = report.incidents
    .flatMap((i) => i.suspects.flatMap((s) => s.components))
    .filter((c) => ["ApexClass", "ApexTrigger", "Flow", "ValidationRule"].includes(c.type));
  if (!components.length) return report;
  const { dates } = componentDatesInOrg(opts.org, components, runner);
  return dates.size ? traceIncidents({ model, collection, history, projectDir, orgDates: dates }) : report;
}

export {
  CATEGORY_LABEL,
  CATEGORY_RULES,
  classifyError,
  describeSignature,
  type ErrorCategory,
  type ErrorSignature,
  type ErrorVocabulary,
  mergeVocabulary,
  vocabularyFromModel,
} from "./classify.js";
export {
  collectIncidents,
  componentDatesInOrg,
  type FailingComponent,
  groupIncidents,
  type Incident,
  type IncidentCollection,
  type IncidentEvent,
  type IncidentSource,
  importErrors,
  parseCsv,
  parseSince,
  parseStack,
  type SourceStatus,
} from "./collect.js";
export { incidentsToMarkdown, rollbackToMarkdown } from "./markdown.js";
export { applyRollback, changeAt, planRollback, type RollbackPlan, type RollbackStep } from "./rollback.js";
export {
  type ChangeRef,
  type HistoryChange,
  historyVocabulary,
  type IncidentReport,
  orgDateKey,
  recentChanges,
  type Suspect,
  type SuspectComponent,
  type TracedIncident,
  traceIncidents,
} from "./trace.js";
