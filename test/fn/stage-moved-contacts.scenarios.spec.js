const { assert, expect } = require('chai');
const rewire = require('rewire');

const PouchDB = require('pouchdb-core');
PouchDB.plugin(require('pouchdb-adapter-memory'));
PouchDB.plugin(require('pouchdb-mapreduce'));
PouchDB.plugin(require('pouchdb-find'));

const stageMovedContactsModule = rewire('../../src/fn/stage-moved-contacts');
const updateLineagesAndStage = stageMovedContactsModule.__get__('updateLineagesAndStage');
const { mockReport, mockHierarchy, parentsToLineage } = require('../mock-hierarchies');
const log = require('../../src/lib/log');
log.level = log.LEVEL_TRACE;

describe('stage-moved-contacts integration tests', () => {

  let pouchDb, scenarioCount = 0;
  const writtenDocs = [];
  const getWrittenDoc = async docId => {
    const result = writtenDocs.find(doc => doc && doc._id === docId);
    if (!result) {
      return undefined;
    }
    
    delete result._rev;
    return result;
  };

  beforeEach(async () => {
    pouchDb = new PouchDB(`scenario${scenarioCount++}`, { adapter: 'memory' });

    await mockHierarchy(pouchDb, {
      district_1: {
        health_center_1: {
          clinic_1: {
            patient_1: {},
          },
        },
      },
      district_2: {},
    });

    await mockReport(pouchDb, {
      id: 'report_1',
      creatorId: 'health_center_1_contact',
    });

    await pouchDb.put({
      _id: '_design/medic-client',
      views: {
        contacts_by_place: {
          // eslint-disable-next-line quotes
          map: "function(doc) {\n  var types = [ 'district_hospital', 'health_center', 'clinic', 'person' ];\n  var idx = types.indexOf(doc.type);\n  if (idx !== -1) {\n    var place = doc.parent;\n    var order = idx + ' ' + (doc.name && doc.name.toLowerCase());\n    while (place) {\n      if (place._id) {\n        emit([ place._id ], order);\n      }\n      place = place.parent;\n    }\n  }\n}"
        },

        reports_by_freetext: {
          // eslint-disable-next-line quotes
          map: "function(doc) {\n  var skip = [ '_id', '_rev', 'type', 'refid', 'content' ];\n\n  var usedKeys = [];\n  var emitMaybe = function(key, value) {\n    if (usedKeys.indexOf(key) === -1 && // Not already used\n        key.length > 2 // Not too short\n    ) {\n      usedKeys.push(key);\n      emit([key], value);\n    }\n  };\n\n  var emitField = function(key, value, reportedDate) {\n    if (!key || !value) {\n      return;\n    }\n    key = key.toLowerCase();\n    if (skip.indexOf(key) !== -1 || /_date$/.test(key)) {\n      return;\n    }\n    if (typeof value === 'string') {\n      value = value.toLowerCase();\n      value.split(/\\s+/).forEach(function(word) {\n        emitMaybe(word, reportedDate);\n      });\n    }\n    if (typeof value === 'number' || typeof value === 'string') {\n      emitMaybe(key + ':' + value, reportedDate);\n    }\n  };\n\n  if (doc.type === 'data_record' && doc.form) {\n    Object.keys(doc).forEach(function(key) {\n      emitField(key, doc[key], doc.reported_date);\n    });\n    if (doc.fields) {\n      Object.keys(doc.fields).forEach(function(key) {\n        emitField(key, doc.fields[key], doc.reported_date);\n      });\n    }\n    if (doc.contact && doc.contact._id) {\n      emitMaybe('contact:' + doc.contact._id.toLowerCase(), doc.reported_date);\n    }\n  }\n}"
        }
      },
    });

    stageMovedContactsModule.__set__('writeDocumentToDisk', (docDirectoryPath, doc) => writtenDocs.push(doc));
    writtenDocs.length = 0;
  });

  afterEach(async () => pouchDb.destroy());

  it('throw if parent does not exist', async () => {
    try {
      await updateLineagesAndStage({
        contactIds: ['clinic_1'], 
        parentId: 'dne_parent_id'
      }, pouchDb);
      assert.fail('should throw when parent is not defined');
    } catch (err) {
      expect(err.name).to.eq('not_found');
    }
  });
  
  it('move health_center_1 to district_2', async () => {
    await updateLineagesAndStage({
      contactIds: ['health_center_1'], 
      parentId: 'district_2',
    }, pouchDb);

    expect(await getWrittenDoc('health_center_1_contact')).to.deep.eq({
      _id: 'health_center_1_contact',
      type: 'person',
      parent: parentsToLineage('health_center_1', 'district_2'),
    });

    expect(await getWrittenDoc('health_center_1')).to.deep.eq({
      _id: 'health_center_1',
      type: 'health_center',
      contact: { _id: 'health_center_1_contact' },
      parent: parentsToLineage('district_2'),
    });

    expect(await getWrittenDoc('clinic_1')).to.deep.eq({
      _id: 'clinic_1',
      type: 'clinic',
      contact: { _id: 'clinic_1_contact' },
      parent: parentsToLineage('health_center_1', 'district_2'),
    });

    expect(await getWrittenDoc('patient_1')).to.deep.eq({
      _id: 'patient_1',
      type: 'person',
      parent: parentsToLineage('clinic_1', 'health_center_1', 'district_2'),
    });

    expect(await getWrittenDoc('report_1')).to.deep.eq({
      _id: 'report_1',
      form: 'foo',
      type: 'data_record',
      contact: parentsToLineage('health_center_1_contact', 'health_center_1', 'district_2'),
    });
  });

  it('move health_center_1 to root', async () => {
    await updateLineagesAndStage({
      contactIds: ['health_center_1'], 
      parentId: 'root',
    }, pouchDb);

    expect(await getWrittenDoc('health_center_1_contact')).to.deep.eq({
      _id: 'health_center_1_contact',
      type: 'person',
      parent: parentsToLineage('health_center_1'),
    });

    expect(await getWrittenDoc('health_center_1')).to.deep.eq({
      _id: 'health_center_1',
      type: 'health_center',
      contact: { _id: 'health_center_1_contact' },
      parent: parentsToLineage(),
    });

    expect(await getWrittenDoc('clinic_1')).to.deep.eq({
      _id: 'clinic_1',
      type: 'clinic',
      contact: { _id: 'clinic_1_contact' },
      parent: parentsToLineage('health_center_1'),
    });

    expect(await getWrittenDoc('patient_1')).to.deep.eq({
      _id: 'patient_1',
      type: 'person',
      parent: parentsToLineage('clinic_1', 'health_center_1'),
    });

    expect(await getWrittenDoc('report_1')).to.deep.eq({
      _id: 'report_1',
      form: 'foo',
      type: 'data_record',
      contact: parentsToLineage('health_center_1_contact', 'health_center_1'),
    });
  });

  it('move district_1 from root', async () => {
    await updateLineagesAndStage({
      contactIds: ['district_1'], 
      parentId: 'district_2',
    }, pouchDb);

    expect(await getWrittenDoc('district_1')).to.deep.eq({
      _id: 'district_1',
      type: 'district_hospital',
      contact: { _id: 'district_1_contact' },
      parent: parentsToLineage('district_2'),
    });

    expect(await getWrittenDoc('health_center_1_contact')).to.deep.eq({
      _id: 'health_center_1_contact',
      type: 'person',
      parent: parentsToLineage('health_center_1', 'district_1', 'district_2'),
    });

    expect(await getWrittenDoc('health_center_1')).to.deep.eq({
      _id: 'health_center_1',
      type: 'health_center',
      contact: { _id: 'health_center_1_contact' },
      parent: parentsToLineage('district_1', 'district_2'),
    });

    expect(await getWrittenDoc('clinic_1')).to.deep.eq({
      _id: 'clinic_1',
      type: 'clinic',
      contact: { _id: 'clinic_1_contact' },
      parent: parentsToLineage('health_center_1', 'district_1', 'district_2'),
    });

    expect(await getWrittenDoc('patient_1')).to.deep.eq({
      _id: 'patient_1',
      type: 'person',
      parent: parentsToLineage('clinic_1', 'health_center_1', 'district_1', 'district_2'),
    });

    expect(await getWrittenDoc('report_1')).to.deep.eq({
      _id: 'report_1',
      form: 'foo',
      type: 'data_record',
      contact: parentsToLineage('health_center_1_contact', 'health_center_1', 'district_1', 'district_2'),
    });
  });
});