trigger ContactTrigger on Contact (after update) {
    ContactTriggerHandler.handleAfterUpdate(Trigger.new, Trigger.oldMap);
}
