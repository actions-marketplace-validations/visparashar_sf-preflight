/**
 * Standard objects that commonly appear as DML targets in Apex. Used to decide whether
 * a declared Apex type is an SObject. Custom objects are recognised by suffix or by
 * presence in the project's `objects/` folder.
 */
export const STANDARD_OBJECTS = [
  "Account", "AccountContactRelation", "AccountTeamMember", "Asset", "Attachment", "Campaign",
  "CampaignMember", "Case", "CaseComment", "Contact", "ContentDocument", "ContentDocumentLink",
  "ContentVersion", "Contract", "EmailMessage", "Entitlement", "Event", "FeedItem", "Group",
  "GroupMember", "Individual", "Lead", "Note", "Opportunity", "OpportunityContactRole",
  "OpportunityLineItem", "OpportunityTeamMember", "Order", "OrderItem", "PermissionSetAssignment",
  "Pricebook2", "PricebookEntry", "Product2", "Quote", "QuoteLineItem", "ServiceContract", "Task",
  "User", "UserRole", "WorkOrder", "WorkOrderLineItem", "ServiceAppointment", "LiveChatTranscript",
  "MessagingSession", "VoiceCall", "Knowledge__kav",
];

const STANDARD_SET = new Set(STANDARD_OBJECTS.map((o) => o.toLowerCase()));

const CUSTOM_SUFFIXES = ["__c", "__e", "__x", "__kav", "__b", "__mdt"];

export function looksLikeSObject(typeName: string, projectObjects: Set<string>): boolean {
  const k = typeName.toLowerCase();
  if (STANDARD_SET.has(k) || projectObjects.has(k)) return true;
  if (k === "sobject") return false;
  return CUSTOM_SUFFIXES.some((s) => k.endsWith(s));
}

/** Apex/system classes that should never be treated as references to project classes. */
export const SYSTEM_CLASSES = new Set(
  [
    "System", "Database", "Schema", "String", "Math", "Date", "Datetime", "Time", "JSON", "Test",
    "Limits", "UserInfo", "Trigger", "Integer", "Decimal", "Double", "Long", "Id", "Map", "List",
    "Set", "Http", "HttpRequest", "HttpResponse", "EventBus", "Messaging", "Type", "Crypto",
    "EncodingUtil", "Url", "Approval", "Site", "ApexPages", "Auth", "Label", "Matcher", "Pattern",
    "Blob", "Boolean", "Object", "Exception", "Search", "FeatureManagement", "Flow", "Logger",
  ].map((c) => c.toLowerCase()),
);
