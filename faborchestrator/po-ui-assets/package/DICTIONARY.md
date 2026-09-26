# DICTIONARY — CMF vocabulary

Compiled from the artifacts Athena supplied. **Every entry below was read from a file; nothing here was inferred.** If a term you need is not in this file, it is UNKNOWN — record it in the gap report and do NOT invent a value.

Sources: CustomChangePriorityStep.xml, CustomChangePriorityWizard.xml, CustomProductionOrderManagementUI.xml, CustomRetrievePOMaterials.xml, CustomRetrieveProductionOrderBasedOnProduct.xml, CustomRetrieveProductionOrders.xml

## TENANTS — read this before using anything below

Facts here come from **two different CMF systems**, and they are not interchangeable:

| Tenant | What it is | Trust it for |
|---|---|---|
| **EntegrisKSPUpgrade** | the artifacts Athena supplied — the target system | field paths, message names, action ids, anything page-specific |
| **CriticalManufacturing** | a live CMF instance we read directly | what the PLATFORM offers: which entity types, functionalities and icon classes exist at all |

**Proven distinct, not assumed.** Of the nine Entegris-specific message names on the reference page, every `Custom*` one is ABSENT from the live tenant. A base-tenant entry tells you a name is *valid CMF*; it does **not** tell you it exists in Entegris. If a value you need is only in the base tenant, that is still a gap — flag it.

---

## 1. Field name → data path

| Term | CMF path | Type | Seen in |
|---|---|---|---|
| ActiveMaterialsCount | `ActiveMaterialsCount` | Integer | 1 file(s) |
| Comment | `CurrentNote.Comment` | String | 1 file(s) |
| DateEnteredStep | `DateEnteredStep` | DateTime | 1 file(s) |
| HoldCount | `HoldCount` | Integer | 1 file(s) |
| IsHot | `IsHot` | Boolean | 2 file(s) |
| Material | `Id` | — | 2 file(s) |
| PlannedEndDate | `PlannedEndDate` | DateTime | 1 file(s) |
| PlannedStartDate | `PlannedStartDate` | DateTime | 1 file(s) |
| PrimaryQuantity | `Quantity` | — | 1 file(s) |
| Priority | `Priority` | Integer | 2 file(s) |
| Product | `Product.Id` | — | 1 file(s) |
| ProductionOrder | `Id` | — | 1 file(s) |
| Step | `Step.Id` | — | 1 file(s) |
| SystemState | `SystemState` | String | 1 file(s) |
| TrackInDate | `TrackInDate` | DateTime | 1 file(s) |
| TrackInId | `ModifiedBy` | String | 1 file(s) |
| TrackInResource | `LastProcessedResource` | EntityType(Resource) | 1 file(s) |

**Rule:** a column linking to a record uses that record's **`Id`** as its path with `type: 11` + `referenceTypeName`. A column on a *joined* entity uses `<Entity>.Id`.

### ⚠ §1 IS NOT THE COMPLETE VOCABULARY

The table above is compiled from the six files Athena supplied. The delivered corpus is
**wider than that**, and it uses paths this table does not name at all — `BatchId`,
`ManufacturerLotNumber`, `SourceSystem` and others. They are outside US-455386, and they are
exactly what the remaining pages are made of.

**A path missing from §1 is therefore not evidence that the path is unknown.** Every column path
in the corpus is in `COLUMN-LABELS.json`, with its message name and with a `dictionaryTerm` that
is `null` for precisely these paths; `dictionaryCoverage` there counts them. Look before you flag
a gap — and flag it if it is genuinely absent from both.

## 2. Scalar type codes (derived by cross-referencing Fields.txt)

| Declared type | `type` code | Seen in |
|---|---|---|
| Boolean | `3` | 2 file(s) |
| DateTime | `2` | 1 file(s) |
| Integer | `5` | 2 file(s) |

**Rule (verified 17/17):** a column carrying a `customTemplate` has **no** type code — the template renders it. A column without one always has a type code.

## 3. Action identifiers

| Button | Action id | Seen in |
|---|---|---|
| Change Priority | `Custom.ChangePriorityAction` | CustomProductionOrderManagementUI.xml |
| Hold | `Material.Hold` | CustomProductionOrderManagementUI.xml |
| Release | `Material.Release` | CustomProductionOrderManagementUI.xml |

## 4. Icon classes

| Button | Icon class | Seen in |
|---|---|---|
| Change Priority | `icon icon-core-st-lg-edit` | CustomProductionOrderManagementUI.xml |
| Hold | `icon icon-mes-st-lg-hold` | CustomProductionOrderManagementUI.xml |
| Release | `icon icon-core-st-lg-release` | CustomProductionOrderManagementUI.xml |
| Traveler Print | `icon icon-core-st-lg-print` | CustomProductionOrderManagementUI.xml |

## 5. Permissions (requiredFunctionality)

| Button | Functionality | Seen in |
|---|---|---|
| Hold | `Material.Hold` | CustomProductionOrderManagementUI.xml |
| Release | `Material.Release` | CustomProductionOrderManagementUI.xml |

## 6. Localized message names

| Message name | Seen in |
|---|---|
| `$(CommentGridLabel)` | 1 file(s) |
| `$(CustomActiveMaterialsCountColumnLabel)` | 1 file(s) |
| `$(CustomChangePriorityActionButtonActionName)` | 1 file(s) |
| `$(CustomHoldCountColumnLabel)` | 1 file(s) |
| `$(CustomTrackInDateColumnLabel)` | 1 file(s) |
| `$(CustomTrackInIdColumnLabel)` | 1 file(s) |
| `$(CustomTrackInResourceColumnLabel)` | 1 file(s) |
| `$(DateEnteredStepColumnLabel)` | 1 file(s) |
| `$(HoldMaterialsWizardActionButtonActionName)` | 1 file(s) |
| `$(IsHotColumnLabel)` | 2 file(s) |
| `$(MaterialColumnLabel)` | 2 file(s) |
| `$(PlannedEndDateLabel)` | 1 file(s) |
| `$(PlannedStartDateLabel)` | 1 file(s) |
| `$(PrimaryQuantityColumnLabel)` | 1 file(s) |
| `$(PrintLotTravelerLabel)` | 1 file(s) |
| `$(PriorityColumnLabel)` | 2 file(s) |
| `$(ProductColumnLabel)` | 1 file(s) |
| `$(ProductionOrderColumnLabel)` | 1 file(s) |
| `$(ReleaseMaterialWizardActionTitle)` | 1 file(s) |
| `$(StepColumnLabel)` | 1 file(s) |
| `$(SystemStateColumnLabel)` | 1 file(s) |

**Naming is inconsistent in this system** — four competing patterns are in use. Where a message name is not listed above, **flag it**; do not extrapolate the pattern.

### ⚠ A FORM FIELD LABEL DOES NOT HAVE TO BE A `$(...)` REFERENCE

Measured across every form field in the delivered exports: **26 labels are `$(...)`
references and 32 are PLAIN TEXT.** Plain text is the **majority** — it is certainly
not the exception, and neither form is the convention.

*(Re-measured 2026-08-27. The earlier figure, 33 to 32, counted three copies of a page
this generator itself produced. Every label they added was a `$(...)` reference, so the
old number flattered that form. Removing them did not change the plain-text count at all.)*

So when the story gives a label and **no message name for it is listed above**, writing
the plain text is legitimate and is usually the better answer. It renders as the caption
the reader expects; an invented `$(UNKNOWN_Something)` renders as a broken key.

Measured failure this rule exists to stop: a caption Athena writes as the plain string
`Change Priority and Hot` came out as `$(UNKNOWN_ChangePriorityAndHot)` — a message name
that was invented, marked unknown, and put on screen in place of a real caption.

**This does not license inventing message names.** The rule above still holds: never
extrapolate a `$(...)` name that is not evidenced. This says the opposite — that not
using one is allowed.

## 6b. What those messages render as on screen

| Message name | Renders as | Seen in |
|---|---|---|
| `$(CommentGridLabel)` | COMMENT | Recording 2026-07-06 102125.mp4 |
| `$(CustomActiveMaterialsCountColumnLabel)` | ACTIVE MATERIALS COUNT | Recording 2026-07-06 102125.mp4 |
| `$(CustomChangePriorityActionButtonActionName)` | Change Priority | Recording 2026-07-06 102125.mp4 |
| `$(CustomHoldCountColumnLabel)` | HOLD COUNT | Recording 2026-07-06 102125.mp4 |
| `$(CustomTrackInDateColumnLabel)` | TRACKIN DATE | Recording 2026-07-06 102125.mp4 |
| `$(CustomTrackInIdColumnLabel)` | TRACKIN ID | Recording 2026-07-06 102125.mp4 |
| `$(CustomTrackInResourceColumnLabel)` | TRACKIN RESOURCE | Recording 2026-07-06 102125.mp4 |
| `$(DateEnteredStepColumnLabel)` | DATE ENTERED STEP | Recording 2026-07-06 102125.mp4 |
| `$(HoldMaterialsWizardActionButtonActionName)` | Hold | Recording 2026-07-06 102125.mp4 |
| `$(IsHotColumnLabel)` | HOT | Recording 2026-07-06 102125.mp4 |
| `$(MaterialColumnLabel)` | MATERIAL | Recording 2026-07-06 102125.mp4 |
| `$(PlannedEndDateLabel)` | PLANNED END DATE | Recording 2026-07-06 102125.mp4 |
| `$(PlannedStartDateLabel)` | PLANNED START DATE | Recording 2026-07-06 102125.mp4 |
| `$(PrimaryQuantityColumnLabel)` | QTY | Recording 2026-07-06 102125.mp4 |
| `$(PrintLotTravelerLabel)` | Print Lot Traveler | Recording 2026-07-06 102125.mp4 |
| `$(PriorityColumnLabel)` | PRIORITY | Recording 2026-07-06 102125.mp4 |
| `$(ProductColumnLabel)` | PRODUCT | Recording 2026-07-06 102125.mp4 |
| `$(ProductionOrderColumnLabel)` | PRODUCTION ORDER | Recording 2026-07-06 102125.mp4 |
| `$(StepColumnLabel)` | STEP | Recording 2026-07-06 102125.mp4 |
| `$(SystemStateColumnLabel)` | SYSTEM STATE | Recording 2026-07-06 102125.mp4 |

Read off the demo recording. This is the **reverse** of ask A3 — it gives display text for names we already hold, not names for labels we lack. Grid headers render upper-case, so the stored message may be mixed case.

## 6c. Action button captions

| Button (internal name) | Caption | Seen in |
|---|---|---|
| Change Priority | Change Priority | Recording 2026-07-06 102125.mp4 |
| Hold | Hold | Recording 2026-07-06 102125.mp4 |
| Traveler Print | Print Lot Traveler | Recording 2026-07-06 102125.mp4 |

`settings.name` is the internal identifier; the caption is a separate `$(…)` label. `Traveler Print` renders as **Print Lot Traveler** — they are not the same string.

## 6d. Framework buttons — do NOT emit these

| Button | Ribbon group | Seen in |
|---|---|---|
| Lock | General | Recording 2026-07-06 102125.mp4 |
| More | Actions | Recording 2026-07-06 102125.mp4 |
| New | General | Recording 2026-07-06 102125.mp4 |
| Refresh | General | Recording 2026-07-06 102125.mp4 |

Supplied by the CMF page framework. They appear in the action bar of every page and are **not** declared in the page definition. A generated page must never emit them.

## 7. Converters

| Converter | Package / name | Seen in |
|---|---|---|
| EntityName | `cmf-mes-business-controls / EntityName` | CustomProductionOrderManagementUI.xml |
| LoadEntities | `cmf-core-dashboards / LoadEntities` | CustomProductionOrderManagementUI.xml |
| LoadEntity | `cmf-core-dashboards / LoadEntity` | CustomProductionOrderManagementUI.xml |

## 8. Component types

| Slot | Package / name | Seen in |
|---|---|---|
| dataSource:QueryDataSource | `cmf-core-dashboards / QueryDataSource` | CustomProductionOrderManagementUI.xml |
| dataSource:ServiceCallDataSource | `cmf-core-dashboards / ServiceCallDataSource` | CustomChangePriorityWizard.xml (a Wizard), **200_LoadMaterialsToFeeder.xml (an ordinary Page)**, 04_BinInventory.xml, 100_TransferInventory.xml, 03_TransferTote.xml — see `SERVICES.json` |
| widget:Form | `cmf-core-dashboards / Form` | CustomChangePriorityStep.xml, CustomProductionOrderManagementUI.xml |
| widget:Grid | `cmf-core-dashboards / Grid` | CustomChangePriorityStep.xml, CustomProductionOrderManagementUI.xml |
| widget:UiPageWidget | `cmf-core-dashboards / UiPageWidget` | CustomChangePriorityWizard.xml |

### ⚠ A `ServiceCallDataSource` is NOT a wizard-only mechanism

The "Seen in" column above is **where a thing was observed, not where it belongs.** For this row it
caused a real defect: the only example ever cited was a Wizard, so a run concluded a service call
implies a wizard, emitted none for an ordinary Page, and asked in its gap report whether the page
*"should instead be a wizard page with a `ServiceCallDataSource`"*. The requirement document had
named the API and its full contract was already in `SERVICES.json`.

Measured across the delivered corpus: **12 contracts appear only on a `Page`**, 3 only on a Wizard,
1 only on a Cluster, and `GetConfigByPath` is invoked from **both** a Page and a Wizard — the same
service, both ways.

**So:** when the story names an API, emit the `ServiceCallDataSource` on whatever page type the story
asks for. Do not withhold it because the page is not a wizard, and do not convert the page into one.
`SERVICES.json` carries a `hosts` field on every entry giving the delivered pages and their UIType.

## 9. Link ports — outputs

| Output port | Seen in |
|---|---|
| `UIPage_17344395343189136_p1734620769952693` | CustomChangePriorityWizard.xml |
| `UIPage_17360824903346001_p17360830028322503` | CustomChangePriorityStep.xml |
| `dataChange` | CustomProductionOrderManagementUI.xml |
| `field$$(IsHotColumnLabel)Change` | CustomChangePriorityStep.xml |
| `field$$(PriorityColumnLabel)Change` | CustomChangePriorityStep.xml |
| `field$$(ProductColumnLabel)Change` | CustomProductionOrderManagementUI.xml |
| `field$$(ProductionOrderColumnLabel)Change` | CustomProductionOrderManagementUI.xml |
| `onTransactionFinish` | CustomProductionOrderManagementUI.xml |
| `property$IsHotChange` | CustomChangePriorityWizard.xml |
| `property$MaterialsChange` | CustomChangePriorityWizard.xml |
| `property$PriorityChange` | CustomChangePriorityWizard.xml |
| `selectedChange` | CustomProductionOrderManagementUI.xml |

## 10. Link ports — inputs

| Input port | Seen in |
|---|---|
| `IsHot` | CustomChangePriorityWizard.xml |
| `Material_ProductionOrder_Name` | CustomProductionOrderManagementUI.xml |
| `Materials` | CustomChangePriorityWizard.xml, CustomProductionOrderManagementUI.xml |
| `Priority` | CustomChangePriorityWizard.xml |
| `ProductionOrder` | CustomProductionOrderManagementUI.xml |
| `ProductionOrder_Name` | CustomProductionOrderManagementUI.xml |
| `ProductionOrder_Product_Name` | CustomProductionOrderManagementUI.xml |
| `UIPage_17360881974222641_p17360883686711738` | CustomChangePriorityStep.xml |
| `UIPage_17360881974222641_p17360883688901745` | CustomChangePriorityStep.xml |
| `data` | CustomChangePriorityStep.xml, CustomProductionOrderManagementUI.xml |
| `materials` | CustomProductionOrderManagementUI.xml |
| `property$Materials` | CustomChangePriorityWizard.xml |
| `refresh` | CustomProductionOrderManagementUI.xml |

## 11. Entities

| Entity | Seen in |
|---|---|
| Material | 1 file(s) |
| Product | 2 file(s) |
| ProductionOrder | 3 file(s) |
| Step | 1 file(s) |

## 12. Query parameters

| Parameter | Seen in |
|---|---|
| `Material_ProductionOrder_Name` | CustomRetrievePOMaterials.xml |
| `ProductionOrder_Name` | CustomRetrieveProductionOrderBasedOnProduct.xml, CustomRetrieveProductionOrders.xml |
| `ProductionOrder_Product_Name` | CustomRetrieveProductionOrderBasedOnProduct.xml, CustomRetrieveProductionOrders.xml |

**Rule:** `<Entity>_<Relation>_<Field>`.

## 13. Naming divergence — spec term differs from CMF path

| Label says | Actual path | Seen in |
|---|---|---|
| Material | `Id` | CustomChangePriorityStep.xml, CustomProductionOrderManagementUI.xml |
| PrimaryQuantity | `Quantity` | CustomProductionOrderManagementUI.xml |
| Product | `Product.Id` | CustomProductionOrderManagementUI.xml |
| ProductionOrder | `Id` | CustomProductionOrderManagementUI.xml |
| Step | `Step.Id` | CustomProductionOrderManagementUI.xml |
| TrackInId | `ModifiedBy` | CustomProductionOrderManagementUI.xml |
| TrackInResource | `LastProcessedResource` | CustomProductionOrderManagementUI.xml |

The label and the stored path disagree for these columns. A user story using the label name will not match the path — look them up here rather than assuming they are equal.

## 14. Columns using customTemplate — NOT modelled

| Path | Template size | Seen in |
|---|---|---|
| `CurrentNote.Comment` | 163 chars | CustomProductionOrderManagementUI.xml |
| `HoldCount` | 838 chars | CustomProductionOrderManagementUI.xml |
| `LastProcessedResource` | 279 chars | CustomProductionOrderManagementUI.xml |
| `ModifiedBy` | 122 chars | CustomProductionOrderManagementUI.xml |
| `SystemState` | 2209 chars | CustomProductionOrderManagementUI.xml |

These carry inline HTML/JS rendering logic we do **not** model. If a spec needs one of these columns, emit the column and **flag the custom rendering as unknown**.

## 14. CMF entity types that exist on the platform

| Entity type | Description | Seen in |
|---|---|---|
| App | Represents an App, either system app or third-party app | live |
| Area | Area Object | live |
| AreaSupplyArea | AreaSupplyArea Object | live |
| AreaTransferRequirementType | AreaTransferRequirementType Object | live |
| Asset | This object represents a unique Asset | live |
| AssetAssetTemplate | This object belongs to an Asset and cannot be managed separa | live |
| AssetDashboard | Relation that maps an Asset to an UI Page. | live |
| AssetDirectory | This object represents an independent Asset Structure | live |
| AssetEvent | This object represents the property values for an Asset. Not | live |
| AssetProperty | This object represents the property values for an Asset. Not | live |
| AssetPropertyDefinition | This object represents a property definition for an Asset | live |
| AutoMLNET | AutoMLNET | live |
| AutomationCommand | This object represents the available automation driver comma | live |
| AutomationCommandParameter | This object represents the parameters for an automation comm | live |
| AutomationController | Represents the automation controller which consists of a set | live |
| AutomationControllerDriverDefinition | Represents the multiple drivers per controller. | live |
| AutomationControllerInstance | Represents an instance of an automation controller. | live |
| AutomationControllerIoTEventDefinition | An Automation Controller IoT Event Definition defines which  | live |
| AutomationDriverDefinition | Represents the automation controller which consists of a set | live |
| AutomationDriverInstance | Represents a computer with an instance of an automation driv | live |
| AutomationEvent | This object represents the available automation events ? inc | live |
| AutomationEventProperty | An automation protocol data type is a data type specific to  | live |
| AutomationJob | This object represents an Automation Job such as a Transport | live |
| AutomationJobWaitItem | This object represents an Automation Job Wait Item | live |
| AutomationManager | Represents a computer with an Automation Manager process run | live |
| AutomationManagerFailover | Represents a computer with an Automation Manager process run | live |
| AutomationProperty | This object represents the available automation properties ? | live |
| AutomationProtocol | The automation protocol represents the technical communicati | live |
| AutomationProtocolDataType | An automation protocol data type is a data type specific to  | live |
| AutomationProtocolDeviceIdentifier | An automation protocol device id defined how the protocol re | live |
| AutomationProtocolExtendedData | An automation protocol extended data defines the extend data | live |
| AutomationProtocolParameter | A parameter is a configuration parameter associated with the | live |
| AutomationProtocolTemplate | An automation protocol template defines some pre-defined ent | live |
| AutomationTasksLibrary | An Automation Task Library is a set of metadata that contain | live |
| AutomationWorkflow | This object represents the available automation events ? inc | live |
| BOM | BOM Object | live |
| BOMInstance | BOM Instance Object | live |
| BOMInstanceItem | BOM Instance Item Object | live |
| BOMInstanceItemMaterial | BOM Instance Item Material Object | live |
| BOMProduct | BOMProduct Object | live |
| BinConversion | This is an object that represents a single bin conversion of | live |
| BinConverter | This is an object that represents a set of bin code conversi | live |
| BusinessPartner | BusinessPartner Object | live |
| Calendar | Calendar Object | live |
| CalendarDay | CalendarDay Object | live |
| CalendarDayShiftDefinitionShift | Calendar Day Shift Definition Shift Object | live |
| Certification | A certification corresponds to a qualification or skill that | live |
| CertificationRequiredQualification | CertificationRequiredQualification Object | live |
| ChangeSet | ChangeSet Object | live |
| ChangeSetItem | ChangeSetItem Object | live |
| ChangeSetStateReviewer | ChangeSetStateReviewer Object | live |
| Chart | Statistical process control chart object | live |
| ChartContextInformation | ChartContextInformation Object | live |
| ChartDataPoint | Statistical process control chart data point | live |
| ChartDataPointContext | ChartDataPointContext Object | live |
| ChartDataPointOccurrence | ChartDataPointOccurrence Object | live |
| ChartDataPointReading | ChartDataPointReading Object | live |
| ChartRule | ChartRule Object | live |
| Checklist | Checklist Object | live |
| ChecklistInstance | CheckList Object Instance | live |

*Showing 60 of 349. The complete set is in `dictionary.json` — look it up there rather than assuming a value is absent.*

The platform's full entity list. Presence here means the type EXISTS IN CMF; it does **not** mean Entegris uses it, and it does not give you its properties — the property catalogue was not recoverable and is still ask A1.

## 15. Security functionalities (requiredFunctionality values)

| Functionality | Module | Seen in |
|---|---|---|
| `Material.Abort` | MES | live |
| `Material.AddToContainer` | MES | live |
| `Material.Approve` | MES | live |
| `Material.Assemble` | MES | live |
| `Material.Attach` | MES | live |
| `Material.AttachConsumable` | MES | live |
| `Material.ChangeCharacteristics` | MES | live |
| `Material.ChangeCost` | Costing | live |
| `Material.ChangeFlowAndStep` | MES | live |
| `Material.ChangeOffFlowInformation` | MES | live |
| `Material.ChangeProduct` | MES | live |
| `Material.ChangeProductionOrder` | OrderManagement | live |
| `Material.ChangeQuantity` | MES | live |
| `Material.ChangeState` | MES | live |
| `Material.ChangeType` | MES | live |
| `Material.ClearSubstrateMap` | Mapping | live |
| `Material.Clone` | MES | live |
| `Material.Collapse` | MES | live |
| `Material.Combine` | MES | live |
| `Material.Comment` | MES | live |
| `Material.Compare` | MES | live |
| `Material.CompleteWeighAndDispense` | WeighAndDispense | live |
| `Material.Compose` | MES | live |
| `Material.CostHistoryReport` | Costing | live |
| `Material.Create` | MES | live |
| `Material.CreateFromTemplate` | MES | live |
| `Material.CreateInspectionOrderSamples` | MES | live |
| `Material.CreateSubProduct` | MES | live |
| `Material.CreateTemplate` | MES | live |
| `Material.Detach` | MES | live |
| `Material.DetachConsumable` | MES | live |
| `Material.Disassemble` | MES | live |
| `Material.Dispatch` | MES | live |
| `Material.DispatchAndTrackIn` | MES | live |
| `Material.Edit` | MES | live |
| `Material.EvaluateDispatchableRule` | MES | live |
| `Material.Expand` | MES | live |
| `Material.Export` | MES | live |
| `Material.FutureFlowReport` | MES | live |
| `Material.GenealogyReport` | MES | live |
| `Material.Grade` | MES | live |
| `Material.History` | MES | live |
| `Material.HistoryReport` | MES | live |
| `Material.Hold` | MES | live |
| `Material.Import` | MES | live |
| `Material.InsertIntoLine` | MES | live |
| `Material.LinkWithMap` | Mapping | live |
| `Material.MaintenanceTrackIn` | MES | live |
| `Material.ManageDependencies` | MES | live |
| `Material.ManageFutureActions` | MES | live |
| `Material.ManageMaps` | Mapping | live |
| `Material.ManageTimeConstraints` | MES | live |
| `Material.MassHold` | MES | live |
| `Material.MassRelease` | MES | live |
| `Material.MassUpdate` | MES | live |
| `Material.MasterDataExport` | MES | live |
| `Material.Merge` | MES | live |
| `Material.MoveNext` | MES | live |
| `Material.Pack` | MES | live |
| `Material.PackPackages` | MES | live |
| `Material.PackPackagesManual` | MES | live |
| `Material.PerformChecklist` | MES | live |
| `Material.PerformFutureAction` | MES | live |
| `Material.PerformProcess` | MES | live |
| `Material.PrintLabel` | MES | live |
| `Material.Receive` | MES | live |
| `Material.RecordAssembledLossBonus` | MES | live |
| `Material.RecordLossBonus` | MES | live |
| `Material.RecordPackageLosses` | MES | live |
| `Material.RecordSubMaterialLosses` | MES | live |
| `Material.Register` | MES | live |
| `Material.RegisterManual` | MES | live |
| `Material.Release` | MES | live |
| `Material.RemoveFromContainer` | MES | live |
| `Material.RemoveFromLine` | MES | live |
| `Material.ReplaceAssemble` | MES | live |
| `Material.ResetFloorLife` | MES | live |
| `Material.Retrieve` | MES | live |
| `Material.Rework` | MES | live |
| `Material.Seal` | MES | live |

*Showing 80 of 1975. The complete set is in `dictionary.json` — look it up there rather than assuming a value is absent.*

Scoped to entities this dictionary already knows. **Observed:** for out-of-the-box operations `actionId` and `requiredFunctionality` carry the SAME identifier (`Material.Hold` is both). But not every operation has one — a custom action defined for a project will not appear in this list at all. Never assume a functionality exists just because an action does; if it is absent here, flag it.

## 16. Icon classes

| Icon class | Seen in |
|---|---|
| `icon-core-connect-iot-lg-apicall` | live |
| `icon-core-connect-iot-lg-arithmeticoperation` | live |
| `icon-core-connect-iot-lg-automation` | live |
| `icon-core-connect-iot-lg-build` | live |
| `icon-core-connect-iot-lg-codeexecution` | live |
| `icon-core-connect-iot-lg-connect` | live |
| `icon-core-connect-iot-lg-connectIOT` | live |
| `icon-core-connect-iot-lg-consolebottom` | live |
| `icon-core-connect-iot-lg-debug` | live |
| `icon-core-connect-iot-lg-entitylogevent` | live |
| `icon-core-connect-iot-lg-equipmentcommand` | live |
| `icon-core-connect-iot-lg-equipmentevent` | live |
| `icon-core-connect-iot-lg-equipmentsetup` | live |
| `icon-core-connect-iot-lg-equipmentsetupresult` | live |
| `icon-core-connect-iot-lg-getproperties` | live |
| `icon-core-connect-iot-lg-intance` | live |
| `icon-core-connect-iot-lg-knowledgebase` | live |
| `icon-core-connect-iot-lg-logmessage` | live |
| `icon-core-connect-iot-lg-restart` | live |
| `icon-core-connect-iot-lg-resume` | live |
| `icon-core-connect-iot-lg-retrieve` | live |
| `icon-core-connect-iot-lg-separateconsole` | live |
| `icon-core-connect-iot-lg-setproperties` | live |
| `icon-core-connect-iot-lg-stepover` | live |
| `icon-core-connect-iot-lg-stop` | live |
| `icon-core-connect-iot-lg-store` | live |
| `icon-core-connect-iot-lg-switch` | live |
| `icon-core-connect-iot-lg-systemevent` | live |
| `icon-core-et-lg-app` | live |
| `icon-core-et-lg-asset` | live |
| `icon-core-et-lg-assetbrowser` | live |
| `icon-core-et-lg-assetdirectory` | live |
| `icon-core-et-lg-assetevent` | live |
| `icon-core-et-lg-assettemplate` | live |
| `icon-core-et-lg-automationcontroller` | live |
| `icon-core-et-lg-automationcontrollerinstance` | live |
| `icon-core-et-lg-automationdriverdefinition` | live |
| `icon-core-et-lg-automationdriverinstance` | live |
| `icon-core-et-lg-automationjob` | live |
| `icon-core-et-lg-automationmanager` | live |
| `icon-core-et-lg-automationprotocol` | live |
| `icon-core-et-lg-automationtaskslibrary` | live |
| `icon-core-et-lg-automationworkflow` | live |
| `icon-core-et-lg-category` | live |
| `icon-core-et-lg-changeset` | live |
| `icon-core-et-lg-checklist` | live |
| `icon-core-et-lg-checklistinstance` | live |
| `icon-core-et-lg-cmfdataset` | live |
| `icon-core-et-lg-cmftimer` | live |
| `icon-core-et-lg-document` | live |
| `icon-core-et-lg-enterprise` | live |
| `icon-core-et-lg-eventrule` | live |
| `icon-core-et-lg-fablive3d` | live |
| `icon-core-et-lg-folder` | live |
| `icon-core-et-lg-generic` | live |
| `icon-core-et-lg-integrationentry` | live |
| `icon-core-et-lg-iotaction` | live |
| `icon-core-et-lg-iotconsumer` | live |
| `icon-core-et-lg-iotconsumerdefinition` | live |
| `icon-core-et-lg-ioteventdefinition` | live |

*Showing 60 of 1563. The complete set is in `dictionary.json` — look it up there rather than assuming a value is absent.*

Naming is `icon-<module>-<kind>-<size>-<name>`: `st` = state/action, `et` = entity type, `lg`/`sm` = size. **This explains the apparent inconsistency in the reference page**: Hold uses `icon-mes-st-lg-hold` and Release uses `icon-core-st-lg-release` because hold is an MES-module icon and release is a Core one. Different modules, not a mistake.

## 17. Base-tenant message names (naming evidence only)

| Message name | Renders as | Seen in |
|---|---|---|
| `$(ActualQuantityGridLabel)` | Actual Qty | live |
| `$(AreasColumnLabel)` | Areas | live |
| `$(ChartDescriptionColumnLabel)` | Description | live |
| `$(ChartNameColumnLabel)` | Name | live |
| `$(ChartParameterColumnLabel)` | Parameter | live |
| `$(ChartTypeColumnLabel)` | Type | live |
| `$(CommentGridLabel)` | Comment | live |
| `$(ContainerColumnLabel)` | Container | live |
| `$(ContainerPositionColumnLabel)` | Container Position | live |
| `$(DateEnteredFacilityColumnLabel)` | Date Entered Facility | live |
| `$(DateEnteredStepColumnLabel)` | Date Entered Step | live |
| `$(DueDateColumnLabel)` | Due Date | live |
| `$(EarliestTimeConstraintDateColumnLabel)` | Earliest Time Constraint Date | live |
| `$(EarliestTimeConstraintTypeColumnLabel)` | Earliest Time Constraint Type | live |
| `$(EndColumnLabel)` | End | live |
| `$(ExpirationDateColumnLabel)` | Expiration Date | live |
| `$(FacilityColumnLabel)` | Facility | live |
| `$(FlowColumnLabel)` | Flow | live |
| `$(FormColumnLabel)` | Form | live |
| `$(InOffFlowColumnLabel)` | In Off-Flow | live |
| `$(InTransitColumnLabel)` | In Transit | live |
| `$(IsHotColumnLabel)` | Hot | live |
| `$(LaneColumnLabel)` | Lane | live |
| `$(LocalMaterialsToReceiveColumnLabel)` | Local Materials To Receive | live |
| `$(LocationColumnLabel)` | Location | live |
| `$(LogisticsColumnLabel)` | Logistics | live |
| `$(MaterialColumnLabel)` | Material | live |
| `$(MaterialDescriptionColumnLabel)` | Material Description | live |
| `$(MaterialsColumnLabel)` | Materials | live |
| `$(OpenDefectCountColumnLabel)` | Open Defect Count | live |
| `$(OpenProtocolsColumnLabel)` | Open Protocols | live |
| `$(OrderColumnLabel)` | Order | live |
| `$(PartitionColumnLabel)` | Partition | live |
| `$(PlanQuantityGridLabel)` | Planned Qty | live |
| `$(PlanedEndDateColumnLabel)` | Planed End Date | live |
| `$(PreparationColumnLabel)` | Preparation | live |
| `$(PrimaryQuantityColumnLabel)` | Qty | live |
| `$(PrimaryUnitsColumnLabel)` | Units | live |
| `$(PriorityColumnLabel)` | Priority | live |
| `$(ProcessedQuantityColumnLabel)` | Processed Quantity | live |

*Showing 40 of 4517. The complete set is in `dictionary.json` — look it up there rather than assuming a value is absent.*

**These are base-tenant messages. Do NOT reuse a name from here for an Entegris page unless the reference artifacts also show it.** Included as evidence of the naming conventions in use, nothing more.

## Conflicts — sources disagree, resolve with Athena

| Bucket | Key | One source says | Another says |
|---|---|---|---|
| actions | Release | `Release (Fields.txt)` | `Material.Release (exported page)` (cross-source check) |

## Quarantined — placeholder values in Athena's own files, deliberately excluded

| Bucket | Key | Value | Source |
|---|---|---|---|
| cmfMessages | Cmf.Foundation.DataPlatform.Framework.Spark.DriverState.UNKNOWN | `UNKNOWN` | cmf-LocalizedMessages.json |
| actions | Traveler Print | `CustomAction.Id` | CustomProductionOrderManagementUI.xml |

---

## Still unknown — must be flagged, never guessed

- entity and property coverage beyond the four entities above (ask A1)
- action ids, icons and permissions for any button not listed (ask A2)
- message names for any label not listed (ask A3)
- how a query body is constructed (ask A4)
- the contents of any `customTemplate`
