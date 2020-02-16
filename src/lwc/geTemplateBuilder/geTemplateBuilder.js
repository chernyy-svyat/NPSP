import { LightningElement, track, api, wire } from 'lwc';
import { NavigationMixin } from 'lightning/navigation';
import storeFormTemplate from '@salesforce/apex/FORM_ServiceGiftEntry.storeFormTemplate';
import retrieveFormTemplateById from '@salesforce/apex/FORM_ServiceGiftEntry.retrieveFormTemplateById';
import TemplateBuilderService from 'c/geTemplateBuilderService';
import GeLabelService from 'c/geLabelService';
import { getObjectInfo } from 'lightning/uiObjectInfoApi';
import {
    dispatch,
    handleError,
    showToast,
    findMissingRequiredFieldMappings,
    findMissingRequiredBatchFields,
    generateId,
    ADDITIONAL_REQUIRED_BATCH_HEADER_FIELDS,
    DEFAULT_BATCH_HEADER_FIELDS,
    EXCLUDED_BATCH_HEADER_FIELDS,
    DEFAULT_FORM_FIELDS
} from 'c/utilTemplateBuilder';
import {
    mutable,
    findIndexByProperty,
    getQueryParameters,
    shiftToIndex,
    sort
} from 'c/utilCommon';
import DATA_IMPORT_BATCH_OBJECT from '@salesforce/schema/DataImportBatch__c';
import FIELD_MAPPING_METHOD_FIELD_INFO from '@salesforce/schema/Data_Import_Settings__c.Field_Mapping_Method__c';

const FORMAT_VERSION = '1.0';
const ADVANCED_MAPPING = 'Data Import Field Mapping';
const DEFAULT_FIELD_MAPPING_SET = 'Migrated_Custom_Field_Mapping_Set';
const GIFT_ENTRY = 'Gift_Entry';
const SORTED_BY = 'required';
const SORT_ORDER = 'desc';
const PICKLIST = 'Picklist';
const BOOLEAN = 'Boolean';
const NEW = 'new';
const EDIT = 'edit';
const SAVE = 'save';
const DELETE = 'delete';
const API_NAME = 'apiName';
const ID = 'id';
const SUCCESS = 'success';
const ERROR = 'error';
const EVENT_TOGGLE_MODAL = 'togglemodal';
const WARNING = 'warning';
const FIELD = 'field';
const WIDGET = 'widget';

export default class geTemplateBuilder extends NavigationMixin(LightningElement) {

    // Expose label service to template
    CUSTOM_LABELS = GeLabelService.CUSTOM_LABELS;

    /*******************************************************************************
    * @description Enums used for navigating and flagging active lightning-tabs.
    */
    TabEnums = Object.freeze({
        INFO_TAB: this.CUSTOM_LABELS.geTabTemplateInfo,
        FORM_FIELDS_TAB: this.CUSTOM_LABELS.geTabFormFields,
        BATCH_HEADER_TAB: this.CUSTOM_LABELS.geTabBatchHeader
    });

    @api formTemplateRecordId;

    existingFormTemplateName;
    currentNamespace;
    @api isClone = false;
    @track isLoading = true;
    @track activeTab = this.TabEnums.INFO_TAB;
    @track formTemplate = {
        name: null,
        description: null,
        batchHeaderFields: [],
        layout: null
    };
    formLayout = {
        fieldMappingSetDevName: null,
        version: null,
        sections: []
    };
    @track batchHeaderFields = [];
    @track formSections = [];
    @track activeFormSectionId;
    @track diBatchInfo;
    @track batchFields;
    @track missingRequiredBatchFields;
    batchFieldFormElements = [];

    @track hasTemplateInfoTabError;
    @track hasSelectFieldsTabError;
    @track hasBatchHeaderTabError;
    @track previousSaveAttempted = false;
    @track sectionIdsByFieldMappingDeveloperNames = {};

    @wire(getObjectInfo, { objectApiName: DATA_IMPORT_BATCH_OBJECT })
    wiredBatchDataImportObject({ error, data }) {
        if (data) {
            this.diBatchInfo = data;

            if (this.connected) {
                // We need to be connected before we can initialize this component.
                this.init();
            } else {
                // So if we haven't connected yet, queue it up.
                this.needToInit = true;
            }
        } else if (error) {
            handleError(this, error);
        }
    }

    get templateBuilderHeader() {
        return this.existingFormTemplateName ? this.existingFormTemplateName : this.CUSTOM_LABELS.geHeaderNewTemplate;
    }

    get mode() {
        return this.formTemplateRecordId === undefined ? NEW : EDIT;
    }

    get inTemplateInfoTab() {
        return this.activeTab === this.TabEnums.INFO_TAB ? true : false;
    }

    get inBatchHeaderTab() {
        return this.activeTab === this.TabEnums.BATCH_HEADER_TAB ? true : false;
    }

    get inSelectFieldsTab() {
        return this.activeTab === this.TabEnums.FORM_FIELDS_TAB ? true : false;
    }

    get namespace() {
        return this.currentNamespace ? `${this.currentNamespace}__` : '';
    }

    connectedCallback() {
        this.connected = true;

        if (this.needToInit) {
            this.init();
        }
    }

    init = async () => {
        try {
            this.currentNamespace = TemplateBuilderService.namespaceWrapper.currentNamespace;

            const queryParameters = getQueryParameters();
            // If we have no template record id, check if there's a record id in the url
            if (!this.formTemplateRecordId) {
                this.formTemplateRecordId = queryParameters.c__formTemplateRecordId;
            }

            if (this.formTemplateRecordId) {
                let formTemplate = await retrieveFormTemplateById({
                    templateId: this.formTemplateRecordId
                });

                this.existingFormTemplateName = formTemplate.name;
                this.formTemplate = formTemplate;
                this.batchHeaderFields = formTemplate.batchHeaderFields;
                this.formLayout = formTemplate.layout;
                this.formSections = this.formLayout.sections;

                this.catalogFieldsForTemplateEdit();
            }

            this.collectBatchHeaderFields();
            this.addRequiredBatchHeaderFields();
            this.validateBatchHeaderTab();
            this.handleDefaultFormFields();

            if (!this.activeFormSectionId && this.formSections && this.formSections.length > 0) {
                this.activeFormSectionId = this.formSections[0].id;
            }

            // Clear out form template record id if cloning after retrieving all relevant data
            if (queryParameters.c__clone || this.isClone) {
                this.formTemplateRecordId = null;
            }

            this.isLoading = false;
        } catch (error) {
            handleError(error);
        }
    };

    /*******************************************************************************
    * @description Method builds and sorts a list of batch header fields for the
    * child component geTemplateBuilderBatchHeader. Takes into consideration
    * additionally required fields and exluded fields. List is used by the sidebar
    * for the lightning-input checkboxes.
    */
    collectBatchHeaderFields() {
        this.batchFields = mutable(this.diBatchInfo.fields);

        Object.getOwnPropertyNames(this.batchFields).forEach((key) => {
            let field = this.batchFields[key];
            const isFieldExcluded = EXCLUDED_BATCH_HEADER_FIELDS.includes(field.apiName);
            const isNewAndNotCreatable = this.mode === NEW && !field.createable;
            const isEditAndNotAccessible = this.mode === EDIT && !field.createable && !field.updateable;

            if (isFieldExcluded || isNewAndNotCreatable || isEditAndNotAccessible) {
                return;
            }

            field.isPicklist = field.dataType === PICKLIST ? true : false;

            if (ADDITIONAL_REQUIRED_BATCH_HEADER_FIELDS.includes(field.apiName)) {
                field.required = true;
            }

            if (field.required && field.dataType !== BOOLEAN) {
                field.checked = true;
                field.isRequiredFieldDisabled = true;
            } else {
                field.checked = false;
                field.isRequiredFieldDisabled = false;
            }

            // Need to set checkbox field types 'required' field to false
            // as it always returns true from the field describe info.
            if (field.dataType === BOOLEAN) {
                field.required = false;
            }

            this.batchFieldFormElements.push(field);
        });

        this.batchFieldFormElements = sort(this.batchFieldFormElements, SORTED_BY, SORT_ORDER);
    }

    /*******************************************************************************
    * @description Method adds all required batch header fields on new templates.
    */
    addRequiredBatchHeaderFields() {
        if (this.mode === NEW) {
            const requiredFields = this.batchFieldFormElements.filter(batchField => {
                return batchField.required;
            });

            requiredFields.forEach((field) => {
                this.handleAddBatchHeaderField({ detail: field.apiName });
            });

            DEFAULT_BATCH_HEADER_FIELDS.forEach((fieldApiName) => {
                this.handleAddBatchHeaderField({ detail: fieldApiName });
            })
        }
    }

    /*******************************************************************************
    * @description Method handles tab validity change events from child components
    * that happen outside an explicit save action.
    *
    * @param {object} event: Event received from any of the following components.
    * geTemplateBuilderTemplateInfo, geTemplateBuilderSelectFields, and
    * geTemplateBuilderBatchHeader.
    */
    handleUpdateValidity(event) {
        this[event.detail.property] = event.detail.hasError;
    }

    /*******************************************************************************
    * @description Handles the onactive event on a lightning-tab element. Sets the
    * activeTab property based on the lightning-tab element's value.
    *
    * @param {object} event: Event received from the lightning-tab element.
    */
    handleOnActiveTab(event) {
        const tabValue = event.target.value;

        switch (tabValue) {
            case this.TabEnums.INFO_TAB:
                this.activeTab = this.TabEnums.INFO_TAB;
                break;
            case this.TabEnums.FORM_FIELDS_TAB:
                this.activeTab = this.TabEnums.FORM_FIELDS_TAB;
                break;
            case this.TabEnums.BATCH_HEADER_TAB:
                this.activeTab = this.TabEnums.BATCH_HEADER_TAB;
                break;
            default:
                this.activeTab = this.TabEnums.INFO_Tab;
        }
    }

    /*******************************************************************************
    * @description Public method for receiving modal related events. Used in the
    * geTemplateBuilderSectionModalBody, GE_modalProxy, GE_TemplateBuilder component's
    * event chain. Handles the section save and section delete actions from the modal.
    *
    * @param {object} modalData: Event object containing the action and section
    * information.
    * component chain: geTemplateBuilderSectionModalBody -> utilDedicatedListener -> GE_TemplateBuilder -> here
    */
    @api
    notify(modalData) {
        if (modalData.action === SAVE) {
            let formSections = mutable(this.formSections);
            let formSection = formSections.find((fs) => { return fs.id === modalData.section.id });

            formSection.label = modalData.section.label;
            this.formSections = formSections;
        }

        if (modalData.action === DELETE) {
            const selectFieldsComponent = this.template.querySelector('c-ge-template-builder-form-fields');
            selectFieldsComponent.handleDeleteFormSection({ detail: modalData.section.id });
        }
    }

    /*******************************************************************************
    * @description Dispatches an event notifying the parent component GE_TemplateBuilder
    * to open a modal.
    *
    * @param {object} event: Event received from child component.
    * component chain: geTemplateBuilderFormSection -> geTemplateBuilderSelectFields -> here
    */
    toggleModal(event) {
        dispatch(this, EVENT_TOGGLE_MODAL, event.detail);
    }

    /*******************************************************************************
    * @description Receives and handles event from child component to set the
    * template name.
    *
    * @param {object} event: Event received from child component.
    * Detail property contains template name string.
    * component chain: geTemplateBuilderTemplateInfo -> here
    */
    handleChangeTemplateInfoName(event) {
        this.formTemplate.name = event.detail;
    }

    /*******************************************************************************
    * @description Receives and handles event from child component to set the
    * template description.
    *
    * @param {object} event: Event received from child component.
    * Detail property contains template description string.
    * component chain: geTemplateBuilderTemplateInfo -> here
    */
    handleChangeTemplateInfoDescription(event) {
        this.formTemplate.description = event.detail;
    }

    /*******************************************************************************
    * @description Receives and handles event from child component to add a new
    * field to batch headers.
    *
    * @param {object} event: Event received from child component.
    * Detail property contains batch header fields array.
    * component chain: geTemplateBuilderbatchHeader -> here
    */
    handleAddBatchHeaderField(event) {
        const fieldName = event.detail;
        let batchField = this.batchFields[fieldName];

        let field = {
            label: batchField.label,
            apiName: batchField.apiName,
            required: batchField.required,
            isRequiredFieldDisabled: batchField.isRequiredFieldDisabled,
            allowDefaultValue: true,
            defaultValue: null,
            dataType: batchField.dataType
        }

        this.batchHeaderFields = [...this.batchHeaderFields, field];
    }

    /*******************************************************************************
    * @description Receives and handles event from child component to update the
    * details on a batch header field.
    *
    * @param {object} event: Event received from child component.
    * Detail property contains batch header field object.
    * component chain: geTemplateBuilderFormField -> geTemplateBuilderbatchHeader -> here
    */
    handleUpdateBatchHeaderField(event) {
        let batchHeaderField = this.batchHeaderFields.find((bf) => {
            return bf.apiName === event.detail.fieldName
        });

        if (batchHeaderField) {
            batchHeaderField[event.detail.property] = event.detail.value;
        }
    }

    /*******************************************************************************
    * @description Receives and handles event from child component to move a batch
    * header field up.
    *
    * @param {object} event: Event received from child component.
    * Detail property contains batch header field api name.
    * component chain: geTemplateBuilderFormField -> geTemplateBuilderbatchHeader -> here
    */
    handleBatchHeaderFieldUp(event) {
        let index = findIndexByProperty(this.batchHeaderFields, API_NAME, event.detail);
        if (index > 0) {
            this.batchHeaderFields =
                shiftToIndex(this.batchHeaderFields, index, index - 1);
        }
    }

    /*******************************************************************************
    * @description Receives and handles event from child component to move a batch
    * header field down.
    *
    * @param {object} event: Event received from child component.
    * Detail property contains batch header field api name.
    * component chain: geTemplateBuilderFormField -> geTemplateBuilderbatchHeader -> here
    */
    handleBatchHeaderFieldDown(event) {
        let index = findIndexByProperty(this.batchHeaderFields, API_NAME, event.detail);
        if (index < this.batchHeaderFields.length - 1) {
            this.batchHeaderFields =
                shiftToIndex(this.batchHeaderFields, index, index + 1);
        }
    }

    /*******************************************************************************
    * @description Receives and handles event from child component to remove a batch
    * header field.
    *
    * @param {object} event: Event received from child component.
    * Detail property contains batch header field array index.
    * component chain: geTemplateBuilderFormField -> geTemplateBuilderbatchHeader -> here
    * OR
    * geTemplateBuilderbatchHeader -> here
    */
    handleRemoveBatchHeaderField(event) {
        this.batchHeaderFields.splice(event.detail, 1);
    }

    /*******************************************************************************
    * @description Receives and handles event from child component to set the
    * form sections property. Used only for actions related to deleting a section.
    * Event is dispatched from geTemplateBuilderSelectFields.handleDeleteFormSection()
    *
    * @param {object} event: Event received from child component.
    * Detail property contains a list of form sections.
    * component chain: geTemplateBuilderSelectFields -> here
    */
    handleRefreshFormSections(event) {
        this.formSections = event.detail;
    }

    /*******************************************************************************
    * @description Method sets the currently active form section id by the provided
    * form section id.
    *
    * @param {object} event: Event received from child component that contains a
    * section id.
    */
    handleChangeActiveSection(event) {
        this.activeFormSectionId = event.detail;
    }

    /*******************************************************************************
    * @description Method creates a default section and adds default form fields
    * defined in imported constant DEFAULT_FORM_FIELDS.
    */
    handleDefaultFormFields() {
        if (this.formSections && this.formSections.length === 0) {
            let sectionId = this.handleAddFormSection({
                detail: { label: this.CUSTOM_LABELS.geHeaderFormFieldsDefaultSectionName }
            });
            let fieldMappingBySourceFieldAndTargetObject = this.getFieldMappingBySourceFieldAndTargetObject();

            Object.keys(DEFAULT_FORM_FIELDS).forEach(sourceFieldApiName => {
                if (DEFAULT_FORM_FIELDS[sourceFieldApiName]) {
                    const key = `${sourceFieldApiName}.${DEFAULT_FORM_FIELDS[sourceFieldApiName]}`;

                    if (fieldMappingBySourceFieldAndTargetObject[key]) {
                        const fieldMapping = fieldMappingBySourceFieldAndTargetObject[key];
                        const objectMapping = TemplateBuilderService
                            .objectMappingByDevName[fieldMapping.Target_Object_Mapping_Dev_Name];

                        let formField = this.constructFormField(objectMapping, fieldMapping, sectionId);

                        this.handleAddFieldToSection(sectionId, formField);
                        this.catalogSelectedField(fieldMapping.DeveloperName, sectionId);
                    }
                }
            });
        }
    }

    /*******************************************************************************
    * @description Method catalogs selected fields when in edit mode so we can toggle
    * each field's corresponding checkbox.
    */
    catalogFieldsForTemplateEdit() {
        for (let i = 0; i < this.formSections.length; i++) {
            const formSection = this.formSections[i];
            formSection.elements.forEach(element => {
                const name = element.componentName ?
                    element.componentName :
                    element.dataImportFieldMappingDevNames[0];

                this.catalogSelectedField(name, formSection.id)
            });
        }
    }

    /*******************************************************************************
    * @description Builds a map of Field Mappings by their Source Field and Target
    * Object api names i.e. npsp__Account1_Street__c.Account.
    */
    getFieldMappingBySourceFieldAndTargetObject() {
        let map = {};
        Object.keys(TemplateBuilderService.fieldMappingByDevName).forEach(key => {
            const fieldMapping = TemplateBuilderService.fieldMappingByDevName[key];
            if (fieldMapping.Source_Field_API_Name && fieldMapping.Target_Object_API_Name) {
                const newKey =
                    `${fieldMapping.Source_Field_API_Name}.${fieldMapping.Target_Object_API_Name}`;
                map[newKey] = TemplateBuilderService.fieldMappingByDevName[key];
            }
        });

        return map;
    }

    /*******************************************************************************
    * @description Method receives an event from the child geTemplateBuilderFormFields
    * component's handleToggleFieldMapping method.
    *
    * @param {object} event: Event received from child component.
    */
    handleToggleFieldMapping(event) {
        let { clickEvent, fieldMappingDeveloperName, fieldMapping, objectMapping } = event.detail;
        let sectionId = this.activeFormSectionId;
        const isAddField = clickEvent.target.checked;

        if (isAddField) {
            sectionId = this.checkFormSectionId(sectionId, clickEvent);

            let formElement;
            if (fieldMapping.Element_Type === FIELD) {
                formElement = this.constructFormField(objectMapping, fieldMapping, sectionId);
            } else if (fieldMapping.Element_Type === WIDGET) {
                formElement = this.constructFormWidget(fieldMapping, sectionId);
            }

            this.catalogSelectedField(fieldMappingDeveloperName, sectionId);
            this.handleAddFieldToSection(sectionId, formElement);
        } else {
            this.handleRemoveFieldFromSection(fieldMappingDeveloperName);
        }
    }

    /*******************************************************************************
    * @description Method checks to see if a new form section needs to be created
    * by the provided section id and click event.
    *
    * @param {string} sectionId: Form section id to check.
    * @param {object} clickEvent: Click event from the field mapping checkbox in the
    * Form Fields tab's sidebar.
    */
    checkFormSectionId(sectionId, clickEvent) {
        const hasNoSection = !this.formSections || this.formSections.length === 0;
        const hasOneSection = this.formSections.length === 1;
        const hasManySections = this.formSections.length > 1;
        const hasNoActiveSection = this.activeFormSectionId === undefined;

        if (hasNoSection) {
            sectionId = this.handleAddFormSection();
        } else if (hasOneSection) {
            sectionId = this.formSections[0].id;
            this.activeFormSectionId = sectionId;
        } else if (hasManySections && hasNoActiveSection) {
            clickEvent.target.checked = false;
            showToast(this.CUSTOM_LABELS.geToastSelectActiveSection, '', WARNING);
        }

        return sectionId;
    }

    /*******************************************************************************
    * @description Maps the given field mapping developer name to the section id.
    * Used to later find and remove gift fields from their sections.
    *
    * @param {string} fieldMappingDeveloperName: Developer name of a Field Mapping
    * @param {string} sectionId: Id of form section this form widget will be in.
    */
    catalogSelectedField(fieldMappingDeveloperName, sectionId) {
        this.sectionIdsByFieldMappingDeveloperNames[fieldMappingDeveloperName] = sectionId;
    }

    /*******************************************************************************
    * @description Constructs a form field object.
    *
    * @param {object} objectMapping: Instance of BDI_ObjectMapping wrapper class.
    * @param {object} fieldMapping: Instance of BDI_FieldMapping wrapper class.
    * @param {string} sectionId: Id of form section this form field will be under.
    */
    constructFormField(objectMapping, fieldMapping, sectionId) {
        return {
            id: generateId(),
            label: `${objectMapping.MasterLabel}: ${fieldMapping.Target_Field_Label}`,
            customLabel: `${objectMapping.MasterLabel}: ${fieldMapping.Target_Field_Label}`,
            required: fieldMapping.Is_Required || false,
            sectionId: sectionId,
            defaultValue: null,
            dataType: fieldMapping.Target_Field_Data_Type,
            dataImportFieldMappingDevNames: [fieldMapping.DeveloperName],
            elementType: fieldMapping.Element_Type,
            fieldApiName: fieldMapping.Target_Field_API_Name,
            objectApiName: objectMapping.Object_API_Name
        }
    }

    /*******************************************************************************
    * @description Constructs a form widget object.
    *
    * @param {object} widget: Currently an instance of BDI_FieldMapping wrapper class
    * made to look like a widget.
    * @param {object} fieldMapping: Instance of BDI_FieldMapping wrapper class
    * @param {string} sectionId: Id of form section this form field will be in.
    */
    constructFormWidget(widget, sectionId) {
        return {
            id: generateId(),
            componentName: widget.DeveloperName,
            label: widget.MasterLabel,
            customLabel: widget.MasterLabel,
            required: false,
            sectionId: sectionId,
            elementType: widget.Element_Type,
            dataImportObjectMappingDevName: widget.Widget_Object_Mapping_Developer_Name,
            dataImportFieldMappingDevNames: widget.Widget_Field_Mapping_Developer_Names,
        }
    }

    /*******************************************************************************
    * @description Method handles creating and inserting a new form section.
    *
    * @param {object} event: An object that contains the label for the form section.
    */
    handleAddFormSection(event) {
        let label = (event && event.detail && typeof event.detail.label === 'string') ?
            event.detail.label :
            this.CUSTOM_LABELS.geHeaderNewSection;

        let newSection = {
            id: generateId(),
            displayType: 'accordion',
            defaultDisplayMode: 'expanded',
            displayRule: 'displayRule',
            label: label,
            elements: []
        }

        this.formSections = [...this.formSections, newSection];
        this.activeFormSectionId = newSection.id;

        return newSection.id;
    }

    /*******************************************************************************
    * @description Receives and handles event from child component to move a form
    * section up.
    *
    * @param {object} event: Event received from child component.
    * Detail property contains sectionId.
    * component chain: geTemplateBuilderFormSection -> geTemplateBuilderSelectFields -> here
    */
    handleFormSectionUp(event) {
        let index = findIndexByProperty(this.formSections, ID, event.detail);
        if (index > 0) {
            this.formSections = shiftToIndex(this.formSections, index, index - 1);
        }
    }

    /*******************************************************************************
    * @description Receives and handles event from child component to move a form
    * section down.
    *
    * @param {object} event: Event received from child component.
    * Detail property contains form section id.
    * component chain: geTemplateBuilderFormSection -> geTemplateBuilderSelectFields -> here
    */
    handleFormSectionDown(event) {
        let index = findIndexByProperty(this.formSections, ID, event.detail);
        if (index < this.formSections.length - 1) {
            this.formSections = shiftToIndex(this.formSections, index, index + 1);
        }
    }

    /*******************************************************************************
    * @description Receives and handles event from child component to add a form
    * field to a form section.
    *
    * @param {object} event: Event received from child component.
    * component chain: geTemplateBuilderSelectFields -> here
    */
    handleAddFieldToSection(sectionId, field) {
        let formSections = mutable(this.formSections);
        let formSection = formSections.find(fs => fs.id === sectionId);

        if (formSection) {
            field.sectionId = sectionId;
            formSection.elements.push(field);
        }

        this.formSections = formSections;
    }

    /*******************************************************************************
    * @description Receives and handles event from child component to remove a form
    * field from a form section.
    *
    * @param {object} event: Event received from child component.
    * component chain: geTemplateBuilderFormField -> geTemplateBuilderFormSection ->
    * geTemplateBuilderSelectFields -> here
    */
    handleRemoveFieldFromSection(fieldName) {
        const sectionId = this.sectionIdsByFieldMappingDeveloperNames[fieldName];

        let formSections = mutable(this.formSections);
        let section = formSections.find(fs => fs.id === sectionId);
        const index = section.elements.findIndex((element) => {
            const name = element.componentName ? element.componentName : element.dataImportFieldMappingDevNames[0];
            return name === fieldName;
        });
        section.elements.splice(index, 1);

        this.formSections = formSections;
    }

    /*******************************************************************************
    * @description Receives and handles event from child component to move a form
    * field up within its parent form section.
    *
    * @param {object} event: Event received from child component.
    * component chain: geTemplateBuilderFormField -> geTemplateBuilderFormSection ->
    * geTemplateBuilderSelectFields -> here
    */
    handleFormElementUp(event) {
        const { sectionId, fieldName } = event.detail;

        let section = this.formSections.find((fs) => { return fs.id === sectionId });
        let index = section.elements.findIndex((element) => {
            const name = element.componentName ? element.componentName : element.dataImportFieldMappingDevNames[0];
            return name === fieldName;
        });

        if (index > 0) {
            section = shiftToIndex(section.elements, index, index - 1);
        }
    }

    /*******************************************************************************
    * @description Receives and handles event from child component to move a form
    * field down within its parent form section.
    *
    * @param {object} event: Event received from child component.
    * component chain: geTemplateBuilderFormField -> geTemplateBuilderFormSection ->
    * geTemplateBuilderSelectFields -> here
    */
    handleFormElementDown(event) {
        const { sectionId, fieldName } = event.detail;

        let section = this.formSections.find((fs) => { return fs.id === sectionId });
        let index = section.elements.findIndex((element) => {
            const name = element.componentName ? element.componentName : element.dataImportFieldMappingDevNames[0];
            return name === fieldName;
        });
        if (index < section.elements.length - 1) {
            section = shiftToIndex(section.elements, index, index + 1);
        }
    }

    /*******************************************************************************
    * @description Receives and handles event from child component to remove a form
    * field from its parent form section.
    *
    * @param {object} event: Event received from child component.
    * component chain: geTemplateBuilderFormField -> geTemplateBuilderFormSection ->
    * geTemplateBuilderSelectFields -> here
    * OR
    * geTemplateBuilderSelectFields -> here
    */
    handleDeleteFormElement(event) {
        const { sectionId, id } = event.detail;

        let section = this.formSections.find((fs) => { return fs.id === sectionId });
        let index = section.elements.findIndex((element) => {
            return element.id === id;
        });

        section.elements.splice(index, 1);
    }

    /*******************************************************************************
    * @description Receives and handles event from child component to update the
    * details of a form field within its parent form section.
    *
    * @param {object} event: Event received from child component.
    * component chain: geTemplateBuilderFormField -> geTemplateBuilderFormSection ->
    * geTemplateBuilderSelectFields -> here
    */
    handleUpdateFormElement(event) {
        const { sectionId, fieldName, property, value } = event.detail;

        let section = this.formSections.find((fs) => { return fs.id === sectionId });
        let element = section.elements.find((e) => {
            const name = e.componentName ? e.componentName : e.dataImportFieldMappingDevNames[0];
            return name === fieldName
        });

        if (element) {
            element[property] = value;
        }
    }

    /*******************************************************************************
    * @description Handles previous and next tab navigation
    *
    * @param {object} event: Event received from lightning-button.
    */
    handleGoToTab(event) {
        this.activeTab = event.target.getAttribute('data-tab-value');
    }

    /*******************************************************************************
    * @description Methods runs validity checks for all tabs, sets tab errors, and
    * throws a toast to notify users which tabs to check.
    */
    checkTabsValidity = async () => {
        let tabsWithErrors = new Set();

        await this.validateTemplateInfoTab(tabsWithErrors);
        this.validateSelectFieldsTab(tabsWithErrors);
        this.validateBatchHeaderTab();

        if (this.hasTemplateInfoTabError || this.hasSelectFieldsTabError || this.hasBatchHeaderTabError) {
            const message = `${tabsWithErrors.size > 1 ?
                this.CUSTOM_LABELS.geToastTemplateTabsError
                : this.CUSTOM_LABELS.geToastTemplateTabError}`;
            const errors = [...tabsWithErrors].join(', ');
            showToast(this.CUSTOM_LABELS.commonError, `${message}${errors}.`, ERROR);

            return false;
        }

        return tabsWithErrors.size === 0 ? true : false;
    }

    /*******************************************************************************
    * @description Method checks for errors in the Template Info tab. Tab currently
    * only has one required field (Name) and this only checks that any value is present
    * there.
    */
    validateTemplateInfoTab = async (tabsWithErrors) => {
        const templateInfoComponent = this.template.querySelector('c-ge-template-builder-template-info');

        if (templateInfoComponent) {
            // Component exists in the dom and can validate itself.
            const isTemplateInfoTabValid = await templateInfoComponent.validate();

            if (isTemplateInfoTabValid) {
                this.hasTemplateInfoTabError = false;
            } else {
                this.hasTemplateInfoTabError = true;
            }
        }

        if (this.hasTemplateInfoTabError) {
            tabsWithErrors.add(this.TabEnums.INFO_TAB);
        }
    }

    /*******************************************************************************
    * @description Method checks for errors in the Select Fields tab. Currently only
    * checks for 'requiredness' in the Field Mapping's source (DataImport__c).
    */
    validateSelectFieldsTab(tabsWithErrors) {
        const selectFieldsComponent = this.template.querySelector('c-ge-template-builder-form-fields');

        if (selectFieldsComponent) {
            // Component exists in the dom and can validate itself.
            this.hasSelectFieldsTabError = !selectFieldsComponent.validate();
        } else {
            // Component doesn't exist in the dom and can't validate itself.
            const missingRequiredFields = findMissingRequiredFieldMappings(
                TemplateBuilderService,
                this.formSections);

            if (missingRequiredFields && missingRequiredFields.length > 0) {
                this.hasSelectFieldsTabError = true;
            } else {
                this.hasSelectFieldsTabError = false;
            }
        }

        if (this.hasSelectFieldsTabError) {
            tabsWithErrors.add(this.TabEnums.FORM_FIELDS_TAB);
        }
    }

    /*******************************************************************************
    * @description Method checks for missing required DataImportBatch__c fields
    * and adds them proactively.
    */
    validateBatchHeaderTab() {
        this.missingRequiredBatchFields = findMissingRequiredBatchFields(this.batchFieldFormElements,
            this.batchHeaderFields);

        if (this.missingRequiredBatchFields && this.missingRequiredBatchFields.length > 0) {
            for (let field of this.missingRequiredBatchFields) {
                this.handleAddBatchHeaderField({ detail: field.apiName });
            }

            const fieldApiNames = this.missingRequiredBatchFields.map(field => field.apiName).join(', ');
            showToast(this.CUSTOM_LABELS.commonWarning,
                `${this.CUSTOM_LABELS.geBodyBatchHeaderWarning} ${fieldApiNames}`,
                'warning',
                'sticky');
        }
    }

    /*******************************************************************************
    * @description Method sets properties on the formTemplate object and passes the
    * FormTemplate JSON to apex and waits for a record id so we can navigate
    * to the newly inserted Form_Template__c record detail page.
    */
    handleFormTemplateSave = async () => {
        this.previousSaveAttempted = true;
        const isTemplateValid = await this.checkTabsValidity();

        if (isTemplateValid) {
            this.isLoading = true;

            if (this.formSections && this.formSections.length === 0) {
                this.handleDefaultFormFields();
            }

            this.formLayout.sections = this.formSections;
            this.formTemplate.batchHeaderFields = this.batchHeaderFields;
            this.formTemplate.layout = this.formLayout;

            // TODO: Currently hardcoded as we're not providing a way to
            // create custom migrated field mapping sets yet.
            this.formTemplate.layout.fieldMappingSetDevName = DEFAULT_FIELD_MAPPING_SET;

            const preppedFormTemplate = {
                id: this.formTemplateRecordId || null,
                templateJSON: JSON.stringify(this.formTemplate),
                name: this.formTemplate.name,
                description: this.formTemplate.description,
                formatVersion: FORMAT_VERSION
            };

            try {
                const recordId = await storeFormTemplate(preppedFormTemplate);
                if (recordId) {
                    let toastLabel =
                        this.mode === NEW ?
                            this.CUSTOM_LABELS.geToastTemplateCreateSuccess
                            : this.CUSTOM_LABELS.geToastTemplateUpdateSuccess;

                    const toastMessage = GeLabelService.format(toastLabel, [this.formTemplate.name]);
                    showToast(toastMessage, '', SUCCESS);
                }

                this.navigateToLandingPage();
            } catch (error) {
                showToast(this.CUSTOM_LABELS.commonError, this.CUSTOM_LABELS.geToastSaveFailed, ERROR);
                this.isLoading = false;
            }
        }
    }

    /*******************************************************************************
    * @description Navigates to Gift Entry landing page.
    */
    navigateToLandingPage() {
        dispatch(this, 'changeview', { view: GIFT_ENTRY });
    }
}