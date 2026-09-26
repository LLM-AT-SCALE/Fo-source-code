# REVISE PROMPT — apply a reader's feedback to the spec descriptor

## Your job

A reader has reviewed the PRD and replied. Decide whether their reply **changes what
should be built**, and if it does, return the descriptor with that change applied.

You return the **whole descriptor**, revised. It is validated against a strict schema,
so every field must still be present and correctly shaped.

---

## The one rule that matters

**Change only what they asked for.**

The reader is looking at a document, not at your reasoning. If they say "add a Priority
column to Materials", add exactly that column to exactly that grid — do not also reorder
the others, rename anything, tidy a label you dislike, or add the column you think
naturally goes with it. Every unrequested change is a requirement nobody asked for, and
it will be built and delivered.

If their reply changes nothing about what is built, **return the descriptor unchanged,
byte for byte.**

---

## What counts as a change, and what does not

**CHANGES the descriptor** — the reader is altering the specification:

| They say | You do |
|---|---|
| "add a Priority column to the Materials grid" | add it to that grid's `columns` |
| "drop the Product filter" | remove that field from the form |
| "the Hold button should be on this page too" | add it to `actionButtons` |
| "Materials should allow single selection only" | change that grid's `selection` |
| "call the page CustomPOConsole" | change `name` |

**DOES NOT change the descriptor** — the reader is reacting to the prose:

| They say | You do |
|---|---|
| "explain the flow more clearly" | nothing — the narrative is rewritten separately |
| "why does it say the screen is for planners?" | nothing |
| "this assumption is wrong" | nothing to the descriptor; the narrative will address it |
| "I don't understand section 3" | nothing |

When you cannot tell which it is, **treat it as prose**. A reader who meant a real
change will say so again; a change made on a guess is silent and ships.

---

## What you must NOT do

- **Do not invent a data path, a CMF type, a query or an entity.** The descriptor speaks
  the story's language. If the reader asks for a column, record the column NAME they used.
  Where the property lives and what type it is are decided later, from the dictionary and
  the entity schema.
- **Do not remove `notes`.** They record what the original extraction could not determine,
  and that is still true after a revision. Add to them where the reader's request itself
  leaves something open.
- **Do not change `userStory` or `schemaVersion`.**
- **Do not renumber, reorder or reformat anything you were not asked to touch.**

---

## Report what you changed

Alongside the descriptor, return a short list of the changes you made, in the reader's
terms — one line each, naming the page and the thing:

```
Materials grid: added column "Priority"
Filter form: removed field "Product"
```

If you changed nothing, return an **empty list**. An empty list with an unchanged
descriptor is the correct answer to "make section 2 clearer", and it is not a failure.

**The list is checked against the descriptor.** A change you make but do not report, or
report but do not make, is a defect — the reader is told exactly this list, and it is
what they will believe happened.
