# EXTRACTION PROMPT — user story → spec descriptor

## Your job

Read a user story and write a **spec descriptor**: a structured statement of what the story
asks for. You are not designing anything and you are not generating CMF artifacts. You are
restating the request in a form a machine can check against.

Write the result to `output/descriptor.json`.

---

## The one rule that matters

**Record only what the story says. Never fill in what it omits.**

The descriptor is the contract every later step is graded against. A detail you invent here
becomes a requirement nobody asked for, and it will be built, validated as correct, and
delivered. That is worse than leaving it out, because an omission is visible and an invention
is not.

If the story is silent on something, one of two things is true:

- it is genuinely optional → leave the field out
- it matters and the story should have said → **record it in `notes`**

A descriptor with a long `notes` array is a good descriptor. It means you read carefully.

---

## Shape

The output must validate against `spec-descriptor.schema.json`. In outline:

```jsonc
{
  "schemaVersion": 1,
  "userStory": "000000",                  // the story's identifier
  "title": "Shipment Review",             // optional, the story's own title
  "pages": [                              // EVERY page the story asks for
    {
      "name": "CustomShipmentReview",
      "uiType": "Page",                   // Page | Wizard | Cluster | Step
      "forms": [
        { "purpose": "data entry",        // optional, free text
          "fields": [ { "label": "Comment", "scalarType": "String" } ] }
      ],
      "filters": [                        // fields that NARROW a list, and which list
        { "entity": "Shipment",           // the grid they narrow, by its entity
          "fields": ["Carrier", "Reference"] }
      ],
      "grids": [
        { "entity": "Shipment",           // the business record it lists
          "selection": "none",            // single | multiple | none
          "columns": [
            { "name": "Reference", "link": true, "entity": "Shipment" },
            { "name": "Weight" }
          ] }
      ],
      "actionButtons": [
        { "name": "Dispatch", "opensPage": "CustomDispatchWizard", "dataSource": "CustomDispatch",
          "control": { "placement": "screen", "inputs": ["Shipments", "Carrier"] } }
      ],
      "autoRefresh": true,                // omit unless the story asks for it
      "autoRefreshInterval": "PT30S"      // ISO 8601 duration, only with autoRefresh
    }
  ],
  "queries": ["CustomRetrieveShipments"], // story-level deliverables
  "api": ["CustomDispatch"],
  "notes": ["the story does not say how the Carrier filter is triggered"]
}
```

## Field-by-field

| Field | Rule |
|---|---|
| `pages` | One entry per page the story names. A story often asks for several. |
| `uiType` | Only if the story states it. It usually does. **A page whose NAME ends in `Step` is not thereby a `Step`** — see below. |
| `forms[].fields[].scalarType` | Only when the story states a type. |
| `filters` vs `forms` | **A filter NARROWS A LIST; a form COLLECTS VALUES.** A story saying "add filter fields at the top of the page" and then "display the results in a grid based on the above filter condition" is describing filters, and the grid it names is what they narrow. A story asking the user to enter a priority and press Save is describing a form. Put a field in one or the other, never both. |
| `filters[].entity` | The grid these narrow, named the same way `grids[].entity` is. If the story's filters narrow a list the story never states, say so in `notes` rather than guessing which grid. |
| `filters[].fields` | Field names, exactly as the story writes them — "Storage Step", not the property you think it maps to. Resolving a name to a data path is the generator's job under Rule 1, and it has evidence you do not. Anything else the story says about a filter — that it is mandatory, that it is a picker — goes in `notes`. |
| `actionButtons[].control` | What the story says about the control itself. Include it whenever the story says EITHER where the button sits or what it acts on — the two are independent. |
| `actionButtons[].control.placement` | `"screen"` for a button in the page body next to what it acts on ("add an Attach button below the grid"); `"actionBar"` for the strip along the top ("add the below button in the action bar"); **`null` when the story does not say** — which is a different answer from `actionBar`, and the honest one. The generator treats the action bar as the majority reading (679 delivered entries over 10 pages, against 18 body buttons over 6) and reports the choice. |
| `actionButtons[].control.inputs` | The values the button acts on, as the story names them: "attach the selected materials to the chosen feeder resource" → `["Materials", "FeederResource"]`. Empty when the story does not say. **Do not infer placement from these** — most delivered action-bar buttons take inputs too. |
| `grids[].entity` | The entity the story names for that grid, as an identifier — a story writing "Sales Order" means the entity `SalesOrder`. Record the normalisation in `notes`. |
| `grids[].role` | **Omit it.** It exists only to tell apart two grids on the same page that list the SAME entity. If the entities differ, the entity alone identifies the grid and a role makes two readings of the same story incomparable. Do not use it to record the story's descriptive wording — that belongs in `notes` if anywhere. |
| `grids[].selection` | From the story's own wording: "single selection" → `single`, "multi selection" → `multiple`. |
| `grids[].columns[].name` | Exactly as the story writes it. Do not correct spelling or expand abbreviations. |
| `grids[].columns[].link` | `true` only where the story marks the column as a link. |
| `grids[].columns[].entity` | Only where the story makes the target unambiguous. If it says "(link)" without naming a target, leave it out and note it. |
| `grids[].columns[].scalarType` | Almost always omitted — stories rarely type their grid columns. Do not infer from the name. |
| `queries` / `api` | Named deliverables **the story asks to be built** — story level, not per page. |
| `pages[].queries` | The queries **that page consumes**. Different thing from the above. Set it whenever the story makes clear which page uses which query — including **`[]` for a page that consumes none**. Omit it only when the story genuinely does not say. |
| `pages[].autoRefresh` | Only where the story asks the page to refresh itself. **Omit it otherwise** — omitted keeps CMF's own default, `false`. Do not set it because a page "shows live data"; set it because the story asked. |
| `pages[].autoRefreshInterval` | ISO 8601 duration — `PT30S`, `PT1M`, `PT2H30M`. Only alongside `autoRefresh: true`; an interval without the switch is rejected. Write the story's own cadence, not a default. |

**Every collection is required, even when empty.** `"actionButtons": []` states the story asks
for none. A missing key would only mean nobody thought about it.

#### A page named `…Step` is still a `Page`

`Step` is a real CMF page class — UIType 1, and every UIType 1 in the platform's own
estate is a wizard step. **But this client does not author them that way.** Their wizard
step, `CustomChangePriorityStep`, ships as `uiType: Page`, hosted inside
`CustomChangePriorityWizard` by a `UiPageWidget`. Across the delivered pages:
**Page 27, Wizard 5, Cluster 4, Step 0.**

So the page's *name* is not evidence of its type. Record `Step` only where the story
says the page IS a wizard step in the CMF sense — not because the name ends that way.
Measured: a run extracting `CustomChangePriorityStep` from its field list chose `Step`
on the strength of the name alone, and the delivered artifact says `Page`.

### `queryDefinitions` — structure, so a query can be BUILT and not just named

`queries` and `pages[].queries` carry **names**. `queryDefinitions` carries **structure**, and it is
what lets us generate the query artifact rather than leave it for a developer.

```jsonc
"queryDefinitions": [
  { "name": "CustomRetrieveShipments",
    "entity": "Shipment",                       // the root entity the query returns
    "fields": ["Id", "Reference", "Carrier.Name"],   // returned columns, in display order
    "joins": [                                  // ONLY where a field or filter path has a dot
      { "path": "Carrier", "entity": "Carrier",
        "sourceProperty": "CarrierId", "targetProperty": "DefinitionId" }
    ],
    "filters": [
      { "path": "Reference", "operator": "Contains", "parameter": true, "optional": true },
      { "path": "UniversalState", "operator": "IsEqualTo", "value": "Active" }
    ] }
]
```

| Field | Rule |
|---|---|
| `entity` | the root entity, as an identifier |
| `fields` | the columns the story says the query **returns**, in the order it lists them |
| `filters[].path` | property path from the root — `Reference`, or `Carrier.Name` across a join |
| `filters[].operator` | one of `IsEqualTo IsNotEqualTo Contains StartsWith GreaterThan GreaterThanOrEqualTo LessThan LessThanOrEqualTo Like NotLike In NotIn` |
| `filters[].parameter` | `true` when the value is supplied at execution — a filter the UI drives |
| `filters[].value` | a literal, for a fixed condition such as `UniversalState = Active` |
| `joins` | **required for any dotted path.** `sourceProperty`/`targetProperty` are real foreign-key columns |

**Only include a query here if the story states its returns and filters.** A query named but not
described belongs in `queries` alone — that is a gap for Athena, and it will be reported as one.
An invented query body is the worst outcome available: it imports cleanly and returns the wrong rows.

> **`queryDefinitions` is not in the schema you are answering against, and that is deliberate.**
> Query structure is **transcribed** from the exports the client has already delivered, after you
> finish — a join cannot be read from prose, and a guessed foreign key produces a query that runs and
> returns the wrong rows. Name the queries in `queries` and, where the story really does describe a
> query we may not hold an export for, say so in `notes` so a human sees it. The section below stays
> here because it documents the shape that transcription produces and that a hand-authored descriptor
> may carry.

**Do not guess `joins`.** The foreign-key columns are schema, not naming convention (on the reference
page `ProductionOrder.ProductId` joins to `Product.DefinitionId`). If the story needs a joined path
and you have no evidence for the key columns, leave the query out of `queryDefinitions` and note it.

> **Why the parameter names matter beyond the query.** A parameterised filter becomes an input port
> on the data source that runs the query, named `<Entity>_<path>` — `Reference` on `Shipment` gives
> `Shipment_Reference`. The UI page's links bind to those exact port names, so the query's filters
> decide the page's wiring.

### Two kinds of "queries" — do not conflate them

- `queries` at story level = **the queries the story asks us to deliver.**
- `pages[].queries` = **the queries that page consumes.**

They are the same list for a one-page story and diverge the moment a story asks for several.
A page is graded against **its own** list when it has one, and against the story's when it does not.

> Worked example, from this project: US-455386 asks for two queries and two pages — a Page that
> uses both, and a **Wizard that uses neither**. With no page-level lists, the wizard was graded
> against both story queries, failed validation, and the generator was pushed into declaring two
> data sources it did not need, wired to nothing. Athena's real wizard has none.
>
> The fix is one line in the descriptor: `"queries": []` on the wizard page.

So: when the story shows which page uses which query, **say so per page** — and use `[]`, not
omission, for a page that consumes none. Omission means "the story does not say", and falls back
to the story's whole list.

---

## `termPaths` — the words you resolved, and why

Requirement documents are written in the client's words; CMF stores properties under its
own. "Storage Step" is the property `Step`. "Batch" is `ManufacturerLotNumber`. "Serial" is
`DateCode`. **Resolving those is the single most frequent thing this tool has had to ask the
client about**, and it used to happen invisibly at generation time where nobody could check it.

So record it. One row per word you had to resolve:

```json
"termPaths": [
  { "term": "Storage Step", "path": "Step",
    "why": "COLUMN-LABELS has a delivered filter on Step labelled $(StepColumnLabel)" },
  { "term": "Batch", "path": "ManufacturerLotNumber",
    "why": "MESSAGE-NAMES: $(CustomBatch) renders as \"Batch\" on their own page" },
  { "term": "Material", "path": null,
    "why": "no delivered filter on a Material name; nothing in the corpus settles it" }
]
```

**Three rules, and the third is the one that matters.**

1. **Every word you resolved goes in**, even the obvious ones. A table that lists only the
   surprising mappings does not tell a reader which words you thought about.
2. **`why` must be checkable.** Name the asset and the evidence — "`$(CustomBatch)` renders
   as Batch" — not "standard CMF naming". A reason nobody can verify is not a reason.
3. **`path: null` is a real answer and often the right one.** It means you met the word and
   the evidence did not settle it. That becomes a question for the client. Guessing a path to
   avoid an empty cell is the one failure this whole table exists to prevent.

**The rest of the descriptor still speaks the STORY's language.** A filter field stays
`"Storage Step"`, not `"Step"` — so the client can read their own words back and check them.
`termPaths` is the separate sheet that says what you took each one to mean.

---

## What belongs in `notes`

- normalisations you performed (entity naming, casing)
- anything the story states ambiguously or contradicts itself on
- anything a builder will obviously need that the story never says — filter triggers, layout,
  what a button actually invokes, empty states
- fields you deliberately left out and why

---

## What is NOT your job

- Do not invent CMF encodings. The descriptor speaks the story's language: `"Integer"`, not
  `type: 5`; `"multiple"`, not `selectionMode: 2`.
- Do not invent message names, icons or action ids. Those are vocabulary and belong to a
  later step, which has evidence for them.
- **Data paths are the exception, and only when the evidence settles them** — see
  `termPaths` below. You are given the same vocabulary assets the generator gets. If they
  answer "what CMF property does this word mean", record the answer; if they do not, record
  that too. What you must never do is compose a path that no evidence supports.
- Do not add columns, buttons or pages that seem sensible. If the story does not ask, it is
  not in the descriptor.
- Do not resolve ambiguity by choosing. Record it in `notes` and move on.

---

## Before you finish

1. Does it validate against the schema?
2. Is every page the story names present?
3. Does every grid have an `entity` and a `selection`?
4. Is there anything in the descriptor the story does **not** say? Remove it.
5. Is there anything the story says that you left out? Add it, or note why not.
6. Is every word you resolved to a CMF path recorded in `termPaths`, with a reason a reader
   can check — and every word you could NOT resolve recorded there with `path: null`?
