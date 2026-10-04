@isTest
private class OpportunityCloserTest {
    @isTest
    static void closesOpportunity() {
        Opportunity opp = new Opportunity(Name = 'Test', StageName = 'Prospecting', CloseDate = Date.today());
        insert opp;
        OpportunityCloser.closeWon(new List<Id>{ opp.Id });
    }
}
