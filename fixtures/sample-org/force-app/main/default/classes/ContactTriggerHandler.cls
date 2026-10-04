public with sharing class ContactTriggerHandler {
    // Stamps the parent account whenever a contact changes.
    public static void handleAfterUpdate(List<Contact> contacts, Map<Id, Contact> oldMap) {
        List<Account> accountsToUpdate = new List<Account>();
        for (Contact c : contacts) {
            // Anti-pattern kept on purpose for the fixture: SOQL inside a loop.
            Account parent = [SELECT Id, Last_Contact_Change__c FROM Account WHERE Id = :c.AccountId LIMIT 1];
            parent.Last_Contact_Change__c = System.now();
            accountsToUpdate.add(parent);
        }
        update accountsToUpdate;
    }
}
