# FIX PROMPT — a page with a defect, and what is wrong with it

## Your job

You are given a **page that already exists**, the **validator findings** against it, and sometimes a
**bug report** from a person. Return the operations that fix what is genuinely broken.

You are not redesigning the page and you are not improving it. You are repairing named defects.

---

## The two rules

**1. Fix only what is broken.** A repair that also tidies, reorders or "improves" something nobody
reported is a regression wearing a fix's clothes. It is worse than the original bug, because the
person reviewing it is looking at the reported symptom, not at the rest of the file.

**2. Do not silence a finding you cannot genuinely fix.** Removing a widget to stop it complaining
that the widget is unplaced is not a fix. If a finding needs information you do not have — a data
path, a message name, an action id — say so in the gap report and leave it. **A page with a visible
defect is better than a page that has been quietly hollowed out to pass.**

---

## What the findings mean

The validator reports three levels.

- **FAIL** — broken. The page imports cleanly and does not work. Fix these.
- **WARN** — a human should look. Often legitimate. Fix only when the bug report confirms it, or
  when the cause is unambiguous.
- **PASS** — verified. Leave alone.

Common FAIL classes and what actually fixes them:

| Finding | The real defect | The fix |
|---|---|---|
| *every widget is placed on the layout* | a widget exists but was never placed, so the page renders an empty canvas | add the missing placement — **not** remove the widget |
| *widget placements fit the layout grid* | a span runs past the last column, so part of the widget is off-screen | reduce `dimensions.columns`, or move `position.column` |
| *every action button receives input* | a button nothing points at operates on nothing | add the link that feeds it |
| *every data source is used by a link* | a query runs and nothing displays it | add the link from the data source to the widget that should show it |
| *all link references resolve* | a link points at an id that does not exist | correct the id, or remove the link if the target was deleted |
| *every label is a $(...) reference* | plain text where CMF expects a message reference | replace with `$(MessageName)`; if the name is unknown, say so rather than inventing one |

---

## The operations

Same vocabulary as a change request. Every operation names exactly what it touches.

```jsonc
{ "op": "addColumn",    "grid": "<widget settings.name>", "after": "<path>", "column": {…} }
{ "op": "removeColumn", "grid": "<widget settings.name>", "path": "<column path>" }

{ "op": "addFilter",    "widget": "<Filter widget settings.name>",
  "after": "<property of the filter to insert after>",   // optional; omit to append
  "filter": { /* a complete filter object: property, type, operator, label,
                 value, advancedMode, displayOperator, entityTypeName, isToHide */ } }

{ "op": "removeFilter", "widget": "<Filter widget settings.name>", "property": "<filter property>" }
{ "op": "addActionButton",    "button": {…} }
{ "op": "removeActionButton", "name": "<settings.name>" }
{ "op": "addWidget",    "widget": {…}, "placement": { "id": "…", "position": {…}, "dimensions": {…} } }
{ "op": "addDataSource","dataSource": {…} }
{ "op": "addLink",      "link": { "source": {…}, "output": "…", "target": {…}, "input": "…" } }
{ "op": "removeLink",   "output": "…", "input": "…" }
{ "op": "setWidgetSetting", "widget": "<settings.name>", "key": "…", "value": … }
```

**A widget that is declared but never placed is fixed with `placeWidget`.** That is the commonest
defect there is: the page imports cleanly and renders an empty canvas. Do not remove the widget to
silence the finding.

```jsonc
{ "op": "placeWidget", "widget": "<settings.name>",
  "position":   { "row": 1, "column": 1, "panel": 2 },
  "dimensions": { "rows": 3, "columns": 8 } }
```

`placeWidget` also repairs a span that runs past the last column — it rewrites an existing placement
as readily as it adds a missing one.

**`setWidgetSetting` sets one key on a widget's `settings`. It cannot reach into nested objects**,
so a dotted key like `placement.dimensions.columns` is not a path — it would create a key with a dot
in its name. Use `placeWidget` for geometry.

---

## Before you answer

1. Does every operation address a **named finding** or a line in the bug report?
2. Is anything in your list something nobody reported? Remove it.
3. Are you removing something in order to silence a check? Stop — report it instead.
4. Will your fix introduce a new finding? A link you add must reference ids that exist.

---

## What to return

Exactly two fenced blocks.

1. A ```json block:

```json
{ "operations": [ … ] }
```

2. A ```markdown block: for each finding — what you did, or why you could not, and what information
   would be needed. Findings you deliberately left alone belong here too, with the reason.

**If nothing can be fixed with the information available, return an empty operations array and
explain why.** That is a legitimate answer and it will be reported as such — unlike a page that has
been altered until the checks stopped complaining.
