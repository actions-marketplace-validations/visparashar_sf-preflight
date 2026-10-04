public with sharing class OpportunityCloser {
    /**
     * Invocable action used by the sales agent to close deals.
     * It does not set Contract_Signed_Date__c, so the validation rule will block it.
     */
    @InvocableMethod(label='Close Opportunity as Won' description='Used by the sales agent')
    public static void closeWon(List<Id> opportunityIds) {
        List<Opportunity> opps = [SELECT Id, StageName FROM Opportunity WHERE Id IN :opportunityIds];
        for (Opportunity o : opps) {
            o.StageName = 'Closed Won';
        }
        update opps;
    }
}
