---
id: 0003
title: The opportunity is the unit of pursuit, and its source must survive the handoff
status: settled
provenance: reconstructed
supersedes:
date: 2026-09-16
---

## The ruling

What the system qualifies is a funding **opportunity**, not an organization.
Discovery must carry the opportunity name and the exact source URL through to
Research. A URL is always one a search actually returned — never generated,
never reconstructed.

A missing opportunity name is not automatically a defect: a general foundation
legitimately has no named programme. A defect is Discovery failing to carry
something it *had*.

## Why

Measured: supplying a known opportunity name took one funder's page shortlist
recall from 0/4 to 4/4, surfacing pages no keyword vocabulary could have
predicted — grant programmes are named arbitrarily. The `candidates` table
already captured `source_url` and `source_title`; intake copied neither into
`prospects`. The most specific thing known about an opportunity was being thrown
away one row before the system that needed it.

## Scope boundary

This authorized fixing the handoff contract. It did **not** authorize redesigning
Discovery.

## Implemented by

`lib/discovery-handoff.ts`, migration `0065_discovery_handoff.sql`. Rows created
before the contract keep `handoff_version 0` and are reported as legacy rather
than back-filled — repairing them by hand would improve a measurement without
improving the system.

**Provenance: reconstructed** from the session transcript.
