---
name: principle-redesign-from-first-principles
description: 要把新需求塞进已有设计时适用。回到第一性原理重做设计，而不是在旧结构上打补丁。Apply when integrating a new requirement into an existing design.
disable-model-invocation: true
---

# Redesign From First Principles

When integrating a change, don't bolt it onto the existing design. Redesign as if the requirement had been a foundational assumption from the start.

- Read all affected files and understand the current design
- Ask: "if we were writing this from scratch with this new requirement, what would we build?"
- Propagate the change through every reference: types, docs, examples, rationale sections
- Think about the whole redesign, then deliver it incrementally

This is the method for preserving option value when integrating changes into an existing design.
