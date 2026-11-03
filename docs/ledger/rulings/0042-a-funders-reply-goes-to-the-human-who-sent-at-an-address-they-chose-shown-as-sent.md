---
id: 0042
title: A funder's reply goes to the human who sent the email, at an address that human chose, shown exactly as it will be sent
status: superseded
provenance: verbatim
supersedes:
date: 2026-11-02
---

## The ruling

1. **A reply goes to the person who sent, never to the platform.** The
   address a funder's reply is directed to belongs to the human who clicked
   Send. It is never the platform's own sending address and never an address
   anyone else, a model, an import or a funder-side source supplied. *(The rule
   the send path has carried since item 57, now stated as an invariant.)*

2. **The sender may choose which of their own addresses that is.** By default
   it is the email address of the account they are signed in with. A person may
   instead set a different address they control — for example their
   organization's address, when they sign in with another — and may clear it to
   return to the default. The choice is theirs and is stored with them, not for
   the platform or the organization, so another person's choice never changes
   whose replies go where. The address is checked for shape; the platform does
   not pretend to verify that the person controls it, because the only replies
   it can misdirect are their own.

3. **What is shown is what is sent, from one source.** The confirmation the
   person reads before sending and the message actually handed to the provider
   take the reply address from the same function, so they cannot differ, and
   the attempt record captures it at its birth, before the provider is called
   (ruling 0029 clause 2). Changing the choice afterwards changes no record of
   anything already sent.

4. **The sending address stays the platform's.** This ruling concerns where
   replies go. It does not change the address a message is sent from, which
   remains platform infrastructure configured by the platform owner, and it does
   not change who may send (ruling 0032) or the one send path (ruling 0029).

## Why

The first live sends showed that the reply address was whatever address the
person happened to sign in with — their agency login, not the organization
whose funders they were writing to. Nothing was wrong with the rule, which
rightly keeps replies away from an unattended platform mailbox; it simply had
no way for a person to say where, among their own addresses, replies belong. A
single platform-wide override would fix the one owner and silently break the
rule for anyone else, so the choice is per person.

## Test of compliance

Set a reply address and open the confirmation: it shows that address, and the
recorded attempt carries the same one. Clear it: it shows the sign-in address.
Enter something that is not an address: it is refused and the default holds. A
second person on the same organization is unaffected. At no setting does the
reply address equal the platform's sending address through the choice alone.

## Scope

Authorizes item 106: a per-person reply address (stored with the person's own
account, no new table), one function supplying it to both the confirmation and
the send, a small control to view, set and clear it, and the tests. Does not
authorize any change to the sending address, the attempt ledger's shape, the
send module's provider call, who may send, or a per-organization sending
identity (item 58).
