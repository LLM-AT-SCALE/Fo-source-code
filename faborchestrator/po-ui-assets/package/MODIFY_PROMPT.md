# MODIFY PROMPT — an existing page plus a change request

## Your job

You are given a **page that already exists** and a **change request**. Return the smallest set of
edit operations that satisfies the request.

You are **not** rewriting the page. You do not return a page definition. You return operations, and
our code applies them to the original file.

---

## The one rule that matters

**Change only what was asked for.**

An enhancement that silently renumbers, reorders, restyles or drops something the request never
mentioned is a **regression** — even when the requested change itself is perfectly correct. It is the
most dangerous failure available here, because the thing that was asked for *did* happen, so it
survives review.

If you think something else on the page is wrong, **say so in the gap report**. Do not fix it.

---

## Why operations and not a rewritten file

A page definition runs to 30,000 characters or more. Re-emitting all of it to add one button means
rewriting every unrelated widget, column and link — and any drift in that re-emission is a silent
regression nobody asked for. Operations keep the blast radius the size of the request.

---

## The operations

Every operation names exactly what it touches. Widgets are identified by their `settings.name`
(the internal identifier, e.g. `"Materials"`), columns by their `path`.

```jsonc
{ "op": "addColumn",    "grid": "<widget settings.name>",
  "after": "<path of the column to insert after>",   // optional; omit to append
  "column": { /* a complete column object */ } }

{ "op": "removeColumn", "grid": "<widget settings.name>", "path": "<column path>" }

{ "op": "addFilter",    "widget": "<Filter widget settings.name>",
  "after": "<property of the filter to insert after>",   // optional; omit to append
  "filter": { /* a complete filter object: property, type, operator, label,
                 value, advancedMode, displayOperator, entityTypeName, isToHide */ } }

{ "op": "removeFilter", "widget": "<Filter widget settings.name>", "property": "<filter property>" }

{ "op": "addActionButton",    "button": { /* a complete action button object, with an id */ } }
{ "op": "removeActionButton", "name": "<settings.name>" }

{ "op": "addWidget", "widget": { /* complete widget */ },
  "placement": { "id": "<same id>", "position": {…}, "dimensions": {…} } }   // omit and it is never rendered

{ "op": "addDataSource", "dataSource": { /* complete data source */ } }

{ "op": "addLink",    "link": { "source": {…}, "output": "…", "target": {…}, "input": "…" } }
{ "op": "removeLink", "output": "…", "input": "…" }

{ "op": "setWidgetSetting", "widget": "<settings.name>", "key": "…", "value": … }
  // one key on the widget's settings. NOT a path — it cannot reach nested objects.

{ "op": "placeWidget", "widget": "<settings.name>",
  "position":   { "row": 1, "column": 1, "panel": 2 },
  "dimensions": { "rows": 3, "columns": 8 } }
  // place a widget that is not on the layout, or correct one that is
```

**Ids must resolve.** A link referring to an id that does not exist in the file — and that no
operation of yours creates — produces a page that imports cleanly and does not work.

**A new widget must be placed.** A widget added without a `placement` exists in the file and never
appears on screen: the page imports, and renders an empty space where it should be.

---

## What our code does, so you do not have to

- **`$id` markers.** Never emit them. Numbering is reassigned after your edits are applied.
- **XML escaping and the envelope.** You return JSON; we write the file.
- **The diff.** We compute what changed and prove nothing else did.
- **Both copies of a hosted widget.** A `Filter` contains the widget it narrows, and that widget is
  also declared in `widgets[]` under the same id. Target it once, by name; we apply your edit to
  both copies so the one the layout draws cannot drift from the one you edited.

---

## Every visible caption is a `$(MessageName)`, never plain text

A `name`, `label` or `buttonTitle` that a user reads is a **message reference**, written
`$(SomeMessageName)`. Plain text there fails validation, and the page is rejected.

So when a change request asks for new wording:

- **An evidenced name that renders that wording** — use it. The label assets in your context list
  which names exist and what they render as.
- **No such name** — emit `$(UNKNOWN_<Wording>)`, e.g. `$(UNKNOWN_SN)`. It is visibly not a real
  name, so it cannot be mistaken for an evidenced one, and it tells the engineer exactly which
  message they need to create. **Say so in your summary**: the caption cannot be delivered until
  that message exists.
- **Never** write the wording itself as the value. `"SN"` is not a caption, it is a defect that
  looks like a caption.

Measured 2026-09-01: a request to rename a column heading to "SN" was applied as the literal string
`SN`. The page failed validation on the label rule, so the engineer got a broken page instead of an
answer to their question.

---

## Before you answer

1. Does every operation name something that **exists** in the supplied page, or that another of your
   operations creates?
2. Is there anything in your list the change request did **not** ask for? Remove it.
3. Is there anything the request asks for that you have **not** covered? Add it, or record in the gap
   report why you could not.
4. A button that operates on rows needs a **link** feeding it the selection, and usually one to
   refresh the data source afterwards. Adding the button alone gives a button that does nothing.

---

## What to return

Exactly two fenced blocks, nothing else outside them.

1. A ```json block:

```json
{ "operations": [ … ] }
```

2. A ```markdown block: the gap report — anything the change request left unclear, anything you
   chose not to touch, and any problem you noticed but deliberately did not fix.

**An empty operations list is an error.** If the request cannot be satisfied by these operations, say
so in the gap report and explain what is missing — do not return nothing and let it look like success.
