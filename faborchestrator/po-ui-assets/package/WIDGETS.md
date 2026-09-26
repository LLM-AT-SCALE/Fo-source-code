# WIDGET CATALOGUE — the components CMF actually offers

Read from the running CMF client on 2026-08-17 (build `10.2.7-473499`) by enumerating the
framework's own runtime metadata. **This is the platform's own declaration, not an inference from
sample pages.**

A widget reference is `{ "package": "<npm package>", "name": "<exported component>" }`.
Every widget below is exported from **`cmf-core-dashboards`** unless a story evidences otherwise.

## Rules

1. **Only use a widget from this list.** A `name` that is not here does not exist, and the page will
   fail to render with no error in the file.
2. **Only use a port from the widget's list below.** `links[].output` must be an output of the
   source; `links[].input` must be an input of the target.
3. **Every widget gets four inputs free** — `name`, `description`, `iconClass`, `loading` — injected
   by the framework. They are omitted from the per-widget lists below to save space.
4. **Dynamic ports exist.** Widgets that bind per-field or per-column expose extra `$`-delimited
   ports, e.g. `Form.field$<Label>$Data`, `Filter.inner$data`. These are legitimate and evidenced on
   live pages, but only use one where a sample shows the pattern.

## The widgets we build with

| Widget | iconClass | Inputs | Outputs |
|---|---|---|---|
| **`Grid`** | `icon-core-st-lg-widgetgrid` | `data` `selected` `pageNumber` `pageSize` `totalRows` `title` `columns` | `selectedChange` `pageSizeChange` `currentPageChange` `columnsChange` |
| **`Form`** | `icon-core-st-lg-widgetform` | `additionalFields` | `submit` `isValidChange` |
| **`UiPageWidget`** | `icon-core-et-sm-uipage` | *(none beyond the free four)* | *(none)* |
| **`Button`** | `icon-core-st-lg-widgetbutton` | `rule` `uiPage` `actionButtonId` `actionId` `buttonIconClass` `buttonTitle` `disabled` `click` `value` | `onTransactionFinish` `onButtonClick` |
| **`Filter`** | `icon-core-st-lg-filter` | `entityTypeName` `disabled` `hidden` `visible` `filters` `filtersToRemove` | `filterCollectionChange` `pageNumberChange` |
| **`EntityListView`** | `icon-core-st-lg-grid` | `data` `selected` `clearSelection` `autoSelectFirstElement` | `selectedChange` |
| **`TextWidget`** | `icon-core-st-sm-widgettext` | `text` `color` | *(none)* |
| **`Flex`** | `icon-core-st-lg-widgetflexwidget` | `direction` `slots` | *(none)* |

`UiPageWidget` embeds one UI Page inside another — this is how a Wizard page hosts its Step page.

## Every widget that exists (40)

```
ARWidget  BICardWidget  BICardWidgetSettingsLayoutPlaceholderWidget  BarCodeIdentification
Button  ColumnViewWidget  ComponentWidget  DataSeriesWidget  DataValueWidget  DateTimeWidget
EDCChart  EntityAttachmentsWidget  EntityDetails  EntityHistoryWidget  EntityInfo
EntityKPIWidget  EntityListView  EntityTiles  EntityTilesMatrixWidget  FabLiveWidget
Filter  Flex  Form  Grafana  Grid  Iframe  Keypad  ListWidget  Query  RealTimeChartWidget
SPCWidget  Shift  SlidingWindow  TabsWidget  TextWidget  TimelineChartWidget  Timer
TransferWidget  TreeMapChartWidget  UiPageWidget
```

## Data sources

`dataSources[]` entries use the same `{package, name}` shape. **`QueryDataSource`** is the one to use
when a story names a query.

### `QueryDataSource` ports
```
in : pageNumber · pageSize · filterCollection
     + <query parameter names>            ← see below, this is the important one
     + refresh                            ← base class; 16 uses across live pages
out: dataChange                           ← base class; 23 uses — THE standard data output
     loadChange · totalRowsChange · pageNumberChange · pageSizeChange
     queryChange · columnsChange · dataSourceRefresh
```

> **A query's parameter names ARE the data source's input port names.** A query with parameters
> `@ProductionOrder_Name` and `@Material_ProductionOrder_Name` gives its data source input ports
> `ProductionOrder_Name` and `Material_ProductionOrder_Name`. Wire the form field or grid selection
> that supplies each parameter into the matching port.

### The standard wiring patterns, ranked by how often live pages use them
```
QueryDataSource.dataChange       -> Grid.data                (or EntityListView.data)
QueryDataSource.loadChange       -> <widget>.loading         (drives the progress indicator)
QueryDataSource.totalRowsChange  -> Grid.totalRows
QueryDataSource.pageNumberChange -> Grid.pageNumber
Grid.selectedChange              -> QueryDataSource.<parameter port>
Button.onTransactionFinish       -> QueryDataSource.refresh
```

### Other data sources that exist (36)
```
AreaSubAreas  BarCodeDataSource  ConsumablesResourceMaterials  FacilityAreasDataSource
GenericTableDataSource  GetStepMaterialsDataSource  HoldReasonsForMaterialDataSource
KPIDynamicDataSource  KPISeriesDataSource  KPIValueDataSource  MaterialContainerDS
MaterialContainerSingleDS  MaterialForMergeDS  MaterialMergeGUIElemDefaultValDS
MaterialsForResource  MaterialsForStorageResource  MaterialsRightPanelDetails
MessageBusDataSource  NonDispatchableMaterialsForResource  OEEDataSource  ProcessKPIDataSource
PublisherDataSource  QueryDataSource  ReleaseHoldReasonsForMaterialDataSource  ResourceLoadPorts
ResourceViewCheckOutEmployeeDS  ResourceViewDurablesDS  ResourceViewMaintenance
ResourcesFromAreaDS  ResourcesKPIDataSource  ServiceCallDataSource  StepsForWorkgroup
SubMaterialDataSource  SubscriberDataSource  SystemDataSource
```
`ServiceCallDataSource` declares **no** ports — everything it exposes is dynamic.

## Converters

A `links[]` entry may pass its value through a converter. These exist (102 total); the generic ones:
```
anyToAnyProperty  anyToEmptyArray  anyToNull  anyToObjectArray  anyToStringProperty  arrayLength
deepCloneOnSuccess  entityName  entitySubtitle  entityAdditionalInfo  filterValue
filterCollectionSearchTerm  instanceToEntityTypeName  isDefined  isEqual  isFalse  isNotDefined
isNotNull  isNullOrEmpty  isPositive  isTrue  loadEntities  loadEntity  loadEntityAttributes
loadObjectByName  mapToArray  mapValueOfArray  nand  ngpDataSetToObjectArray  nullOr
nullToEmptyString  nullWhenParamsNull  paramToOutput  queryToObjectArray  relationToEntity
selectedItemsToText  setIfAllPropertiesEqual  setInArray  setInFIFO  setMapValue  setPropertyOf
sort  stringToBoolean  stringToInteger
```
**`entityName`** converts a selected record into its name — the usual way a grid selection feeds a
query parameter that expects a string.

**Do not author a converter reference unless a sample evidences the exact JSON shape.** The names
above tell you a converter *exists*; they do not tell you how it is serialised inside a link. If a
link plainly needs one, emit the link without it and raise it in the gap report.

## Widget `settings` — emit exactly these keys

**Follow Athena's delivered pages.** Where the base tenant and Athena's export differ, Athena wins:
their artifact is the strongest evidence of what they expect, and their tenant is the target.

### `Grid` settings — as Athena's reference page emits them
```jsonc
{
  "name": "...",              // internal identifier, plain text, NOT $(...)
  "description": "",
  "iconClass": "icon-core-st-lg-widgetgrid",
  "inputs": [],
  "showHeader": false,
  "allowFullscreen": false,
  "allowCopy": false,          // "Allow Open as Image in a Tab" in the builder
  "allowExport": false,        // "Allow Export as Image"
  "hideProgressIndicator": false,
  "columns": [ ... ],
  "selectionMode": 1,          // 1 single, 2 multiple
  "singleElementPreSelect": false,
  "resizable": true,
  "title": "",
  "showOnlyTotalItemsInSmallerWidths": true
}
```

### `Form` settings
```jsonc
{
  "name": "...", "description": "", "iconClass": "icon-core-st-lg-widgetform",
  "inputs": [],
  "showHeader": false, "allowFullscreen": false,
  "allowCopy": false, "allowExport": false, "hideProgressIndicator": false,
  "fields": [ ... ]
}
```

> **Why these are emitted even though live base-tenant pages omit them.** `allowCopy`,
> `allowExport` and `hideProgressIndicator` appear on **0 of 9** base-tenant Grids and **0 of 2**
> Forms — CMF does not serialise them when left at their default of `false`. But they are **real
> builder options** ("Allow Open as Image in a Tab", "Allow Export as Image", "Hide Widgets Progress
> Indicators"), and **Athena's reference page emits all three on every widget**. Emitting them is
> verbose, not wrong; omitting them would diverge from the page we are being measured against.

### `UiPageWidget` settings — how one page embeds another
```jsonc
{
  "name": "...", "description": "", "iconClass": "icon-core-et-sm-uipage",
  "inputs": [], "showHeader": false, "allowFullscreen": false,
  "hideProgressIndicator": false,
  "uiPageType": null,
  "uiPage": {
    "$type": "Cmf.Foundation.BusinessObjects.UIPage, Cmf.Foundation.BusinessObjects",
    "Id": "UNKNOWN",                    // assigned by CMF — see the note below
    "Name": "<the embedded page name>"
  }
}
```
`uiPage` is a **minimal three-key** serialised page reference — not the seventeen-key form the query
block uses. `Id` is assigned by the source system; for a page that does not yet exist in the target,
emit `"UNKNOWN"` and raise it in the gap report.

**This is how a Wizard hosts its Step page.** A Wizard page whose only widget is a `UiPageWidget`
pointing at the Step page is the documented pattern.

## `links[]` — emit these keys

Measured across **3,309 live links**:
```jsonc
{
  "id": "...",
  "source": { "id": "...", "type": 1 },
  "output": "...",
  "target": { "id": "...", "type": 1 },
  "input":  "...",
  "converter": null,     // 2,865 / 3,309 links carry this key
  "param":     null      // 2,865 / 3,309 — the converter's argument
}
```
`converter` and `param` are on **87%** of live links, and on **every** link of Athena's reference
page. **Emit both, as `null` when no converter is needed.** `forceChange` is a third optional key
(339 base-tenant links); Athena's page does **not** use it — omit it.

### The converter reference — use the OBJECT form

Two forms exist, exactly mirroring the two widget-reference forms:

| Form | Used by | Shape |
|---|---|---|
| **object** — `package` + `name` | **Athena's pages** | `{ "package": "cmf-mes-business-controls", "name": "EntityName" }` |
| path string | base-tenant pages | `"cmf.core.dashboards/src/converters/anyToAnyProperty/anyToAnyProperty"` |

**Emit the object form.** Note the **PascalCase** `name` — it is the exported class name
(`EntityName`, `LoadEntity`, `LoadEntities`), not the camelCase metadata name listed earlier in this
file (`entityName`, `loadEntity`). Same convention as widgets: `Grid`, `Form`, `UiPageWidget`.

Converters on Athena's reference page, with their packages:
```
cmf-mes-business-controls / EntityName     ← grid selection → query parameter
cmf-core-dashboards      / LoadEntity
cmf-core-dashboards      / LoadEntities
```

### ★ `param` is a PAGE PROPERTY ID, not a literal

```json
"converter": { "package": "cmf-mes-business-controls", "name": "EntityName" },
"param": "UIPage_172950128565572620_p172950211516780150"
```
That id is an entry in the page's own `properties[]`. The builder calls it the "Converter Parameter"
and the build document describes its purpose as `LevelsToLoad` — but what is **serialised** is a
reference to a page property holding that value, **not the string `LevelsToLoad`.**

**Consequence:** a link that needs a converter parameter also needs a **custom page property** to
hold it. Athena's page carries three such properties beyond the five standard ones. Our settings
shell provides only the five. **If a story requires a parameterised converter, emit the link with
`"converter": null, "param": null` and raise it in the gap report** — inventing a page-property id
that nothing defines would produce a dangling reference.

## `actionButtons[].settings`

`Measured` across 1,015 live buttons, but **follow Athena's delivered page where the two differ** —
Athena's tenant is the target and their page is the closest evidence of intent.

Emit as Athena's page does: `name` (plain text), `buttonTitle` (`$(...)`), `description`,
`actionId`, `iconClass`, `requiredFunctionality` where the action has one, `inputs`.

Base-tenant buttons additionally carry, on **1,015 of 1,015**: `actionButtonId`, `isPrimary`,
`autoRefresh`, `backgroundColor`, `rule`, `textColor`; and mostly `executionType`, `outputs`,
`preventNavigation`. **They do not generally carry `buttonTitle` or `iconClass`** — those appear to
come from the action definition. Athena's page carries them, so we do too.

`executionType` in live use: `0` Action (987) · `2` UIPage (3) · `1` Rule never observed.

Real `actionId` values confirmed in the platform include `Material.Hold`, `Material.Release`,
`Material.TrackIn`, `Material.Split`, `Material.Merge`, `Material.Rework`, `Material.Attach`,
`Material.Detach`, `Material.Receive`, `Material.ChangeType`, `Material.PostData`.

## The `dataSources[].settings.query` reference block

Measured across **39 references on 20 live pages**. The value is a **fully serialised QueryObject**,
not a name reference, and every value is a **string** — including the booleans.

**Emit these, with these values:**
```json
"query": {
  "$type": "Cmf.Foundation.BusinessObjects.QueryObject.QueryObject, Cmf.Foundation.BusinessObjects",
  "Name": "<the query name>",
  "EntityTypeName": "<the entity the query returns>",
  "Description": "",
  "QueryGroup": "",
  "IsSystemQuery": "False",
  "IsDefault": "False",
  "IsPrivate": "False",
  "ObjectLocked": "False",
  "UniversalState": "Active",
  "LockType": "FullAccess",
  "Id": "UNKNOWN",
  "CreatedBy": "UNKNOWN", "CreatedOn": "UNKNOWN",
  "ModifiedBy": "UNKNOWN", "ModifiedOn": "UNKNOWN",
  "LastServiceHistoryId": "UNKNOWN", "LastOperationHistorySequence": "UNKNOWN"
}
```

- **Never emit `Revision`** — it appears in **0 of 39** live references.
- **Never emit `DefinitionId`** — likewise **0 of 39**.
- **Do not emit `$id`** — our post-processor applies it (Rule 6).
- `Id` and the audit fields are **assigned by CMF** in the source system. For a query that does not
  yet exist in the target tenant you cannot know them: emit `UNKNOWN` and record in the gap report
  that **whether import resolves the query by `Name` or requires `Id` is an open question**.
- `Folder` (60/69) and an inline `Query` body (60/69) also appear on live pages. Omit both unless
  the story evidences them.

## What was previously wrong — do not reintroduce

Earlier generated pages emitted:
```json
"query": { "Name": "...", "Id": "UNKNOWN", "DefinitionId": "UNKNOWN", "Revision": "A" }
```
Three faults: `Revision` does not belong, `DefinitionId` does not belong, and 15 mandatory keys were
missing — starting with `$type`.
