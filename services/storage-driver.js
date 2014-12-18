var _ = require('underscore');
var mongo = require('mongodb');
var MongoClient = require('mongodb').MongoClient;
var GridStore = require('mongodb').GridStore;
var Q = require('q');
var moment = require('moment');
var crypto = require('crypto');

var UserCollectionName = "User";

module.exports = function (dbUrl) {
    var service = {};
    var db;
    var onConnectListeners = [];

    MongoClient.connect(dbUrl, function(err, database) {
        if(err) throw err;
        db = database;
        onConnectListeners.forEach(function (listener) {listener()});
    });

    function toPromise(query, method) {
        var deferred = Q.defer();
        query[method](function (err, result) {
            if (err) {
                deferred.reject(new Error(err));
            } else {
                deferred.resolve(result);
            }
        });
        return deferred.promise;
    }

    function deferredCallback(deferred) {
        return function (err, result) {
            if (err) {
                deferred.reject(new Error(err));
            } else {
                deferred.resolve(result);
            }
        }
    }

    service.addOnConnectListener = function (listener) {
        if (db) {
            listener();
        } else {
            onConnectListeners.push(listener);
        }
    };

    service.findCount = function (table, filteringAndSorting) {
        return onlyFilteringEnsureIndexes(table, filteringAndSorting).then(function () {
            return toPromise(db.collection(table.tableName).find(queryFor(table, filteringAndSorting)), 'count');
        })
    };

    service.findAll = function (table, filteringAndSorting) {
        return ensureIndexes(table, filteringAndSorting).then(function () {
            return toPromise(db.collection(table.tableName).find(queryFor(table, filteringAndSorting)).sort(sortingFor(filteringAndSorting, table.fields)), 'toArray')
                .then(function (result) { return result.map(fromBson(table.fields)) });
        });
    };

    service.findRange = function (table, filteringAndSorting, start, count) {
        return ensureIndexes(table, filteringAndSorting).then(function () {
            return toPromise(db.collection(table.tableName).find(queryFor(table, filteringAndSorting)).sort(sortingFor(filteringAndSorting, table.fields)).limit(count).skip(start), 'toArray')
                .then(function (result) { return result.map(fromBson(table.fields)) });
        });
    };

    service.findUser = function (username) {
        return toPromise(db.collection(UserCollectionName).find({username: username}), 'toArray')
            .then(function (result) {
                return result[0];
            });
    };

    service.findUserById = function (id) {
        return toPromise(db.collection(UserCollectionName).find({_id: toMongoId(id)}), 'toArray')
            .then(function (result) {
                return result[0];
            });
    };

    service.createUser = function (username, passwordHash, roles, isGuest) {
        var deferred = Q.defer();
        var userId = new mongo.ObjectID();
        db.collection(UserCollectionName)
            .insert({_id: userId, username: username, passwordHash: passwordHash && passwordHash(userId.toString()) || undefined, roles: roles, isGuest: isGuest}, {}, deferredCallback(deferred));
        return deferred.promise.then(function (result) {
            return result[0];
        });
    };

    function sortingFor(filteringAndSorting, fields) {
        return _.union(filteringAndSorting && filteringAndSorting.sorting && filteringAndSorting.sorting.filter(function (i) { return !!fields[i[0]]}) || [], [['modifyTime', -1]]);
    }

    function ensureIndexes(table, filteringAndSorting) {
        var indexFieldHash = {};
        var indexes = [];

        indexes = sortingFor(filteringAndSorting, table.fields);
        indexes.forEach(function (i) { indexFieldHash[i[0]] = true });

        var query = queryFor(table, filteringAndSorting);
        _.forEach(query, function (q, fieldName) {
            if (!indexFieldHash[fieldName]) {
                indexes.unshift([fieldName, 1]);
                indexFieldHash[fieldName] = true;
            }
        });

        if (indexes.length > 0) {
            var collection = db.collection(table.tableName);
            return Q.nfbind(collection.ensureIndex.bind(collection))(indexes);
        } else {
            return Q(null);
        }
    }

    function onlyFilteringEnsureIndexes(table, filteringAndSorting) {
        var indexFieldHash = {};

        var query = queryFor(table, filteringAndSorting);
        _.forEach(query, function (q, fieldName) {
            indexFieldHash[fieldName] = 1;
        });

        if (_.size(indexFieldHash) > 0) {
            var collection = db.collection(table.tableName);
            return Q.nfbind(collection.ensureIndex.bind(collection))(indexFieldHash);
        } else {
            return Q(null);
        }
    }

    var dateFields = {
        createTime: {
            fieldType: {
                id: 'date'
            }
        },
        modifyTime: {
            fieldType: {
                id: 'date'
            }
        }
    };

    function queryFor(table, filteringAndSorting) {
        var query = {};
        if (filteringAndSorting) {
            if (filteringAndSorting.textSearch) {
                var split = splitText(filteringAndSorting.textSearch);
                if (split.length > 0) {
                    query.$and = split.map(function (value) { return {__textIndex: { $regex: value + ".*" }}});
                }
            }
            if (filteringAndSorting.filtering) {
                var allFields = _.extend({}, table.fields, dateFields);
                _.each(allFields, function (field, fieldName) {
                    if (_.isUndefined(filteringAndSorting.filtering[fieldName])) {
                        return;
                    }
                    var filterValue = filteringAndSorting.filtering[fieldName];
                    if (field.fieldType.id == 'reference') {
                        query[fieldName + '.id'] = toMongoId(filteringAndSorting.filtering[fieldName])
                    } else if (field.fieldType.id == 'checkbox') {
                        query[fieldName] = filteringAndSorting.filtering[fieldName] ? filteringAndSorting.filtering[fieldName] : {$in: [false, null]};
                    } else if (field.fieldType.id == 'date') {
                        if (filterValue.op === 'gt') {
                            query[fieldName] = {$gt: filterValue.value}; //TODO convert from string?
                        } else if (filterValue.op === 'lt') {
                            query[fieldName] = {$lt: filterValue.value}; //TODO convert from string?
                        } else {
                            query[fieldName] = filterValue;
                        }
                    } else if (field.fieldType.id == 'text') {
                        if (filterValue.op === 'startsWith') {
                            query[fieldName] = { $regex: filterValue.value + ".*" };
                        } else if (filterValue.op === 'in') {
                            query[fieldName] = { $in: filterValue.value };
                        } else {
                            query[fieldName] = filterValue;
                        }
                    } else {
                        query[fieldName] = filteringAndSorting.filtering[fieldName];
                    }
                });
            }
        }
        return query;
    }

    service.queryFor = queryFor;

    service.createEntity = function (table, entity) {
        var deferred = Q.defer();
        var objectID = entity.id && toMongoId(entity.id) || new mongo.ObjectID();
        entity.id = (objectID).toString();
        var toInsert = toBson(table.fields)(entity);
        toInsert._id = objectID;
        toInsert.createTime = new Date();
        toInsert.modifyTime = new Date();
        setAuxiliaryFields(table.fields, toInsert, toInsert);
        db.collection(table.tableName)
            .insert(toInsert, {}, deferredCallback(deferred));
        return deferred.promise.then(callEntityListeners(table, null, fromBson(table.fields)(toInsert))).then(function (result) {
            return result[0]._id;
        });
    };

    service.aggregateQuery = function (table, aggregatePipeline) {
        var collection = db.collection(table.tableName);
        return Q.nfbind(collection.aggregate.bind(collection))(aggregatePipeline).then(function (rows) {
            return rows.map(fromBson(table.fields));
        })
    };

    function padId(id) {
        return id.length < 12 ? _.range(0, 12 - id.length).map(function () {return " "}).join("") + id : id;
    }

    function toMongoId(entityId) {
        return new mongo.ObjectID(padId(entityId));
    }

    service.readEntity = function (table, entityId) {
        return toPromise(db.collection(table.tableName).find({_id: toMongoId(entityId)}), 'toArray').then(function (result) {
            if (result.length !== 1) {
                throw new Error("Expected length 1 but got: " + result.length);
            }
            return fromBson(table.fields)(result[0]);
        });
    };

    function promiseFindAndModify(tableName, query, sort, update, options) {
        var deferred = Q.defer();
        db.collection(tableName)
            .findAndModify(query, sort, update, options, deferredCallback(deferred));
        return deferred.promise;
    }

    service.updateEntity = function (table, entity) {
        var toUpdate = toBson(table.fields)(entity);
        toUpdate.modifyTime = new Date();

        return service.readEntity(table, entity.id).then(function (oldEntity) {
            var deferred = Q.defer();
            db.collection(table.tableName)
                .findAndModify({_id: toMongoId(entity.id)}, {}, {$set: toUpdate}, {}, deferredCallback(deferred));
            return deferred.promise.then(callEntityListeners(table, oldEntity, fromBson(table.fields)(toUpdate))).then(function () { //TODO toUpdate doesn't have id
                return service.readEntity(table, entity.id).then(function (result) {
                    var update = {};
                    setAuxiliaryFields(table.fields, result, update);
                    return promiseFindAndModify(table.tableName, {_id: toMongoId(entity.id)}, {}, {$set: update}, {});
                });
            }).then(function (result) {
                return fromBson(table.fields)(result);
            });
        });
    };

    service.deleteEntity = function (table, entityId) {
        return service.readEntity(table, entityId).then(function (oldEntity) {
            var deferred = Q.defer();
            db.collection(table.tableName).findAndRemove({_id: toMongoId(entityId)}, {}, {}, deferredCallback(deferred));
            return deferred.promise.then(callEntityListeners(table, oldEntity, null));
        })
    };

    function callEntityListeners(table, oldEntity, newEntity) {
        return function (result) {
            return entityListeners[table.tableName] &&
                Q.all(entityListeners[table.tableName].map(function (listener) { return listener(oldEntity, newEntity) })).then(function () { return result }) ||
                result;
        }
    }

    function setAuxiliaryFields(fields, entity, toUpdate) {
        setTextIndex(fields, entity, toUpdate);
    }

    function setTextIndex(fields, entity, toUpdate) {
        var strings = convertEntity(fields, function (value, field) {
            if (field.fieldType.id == 'reference' && value) {
                return value.name && value.name.toString() || undefined;
            }
            return value && value.toString() || undefined;
        }, entity);
        toUpdate.__textIndex = _.chain(strings).map(splitText).flatten().unique().value();
    }

    function splitText(str) {
        return _.filter(str.toLowerCase().split(/[1-9,.;:\- ]/), function (str) {
            return str.trim().length > 0;
        });
    }

    function fromBson(fields) {
        return function (entity) {
            var result = convertEntity(fields, fromBsonValue, entity);
            if (entity._id) {
                result.id = entity._id.toString();
            }
            return result;
        }
    }

    service.fromBson = fromBson;

    function toBson(fields) { //TODO it doesn't convert id
        return function (entity) {
            return convertEntity(fields, toBsonValue, entity);
        }
    }

    function convertEntity(fields, convertFun, entity) {
        var result = {};
        _.each(fields, function (field, fieldName) {
            var value = convertFun(entity[fieldName], field, entity);
            if (value && (value.$$push || value.$$pull)) {
                var mergeOp = value.$$push || value.$$pull;
                if (!result[mergeOp.field] || !_.isArray(result[mergeOp.field])) {
                    result[mergeOp.field] = [];
                }
                if (value.$$push && !_.contains(result[mergeOp.field], mergeOp.value)) {
                    result[mergeOp.field].push(mergeOp.value);
                } else if (value.$$pull && _.contains(result[mergeOp.field], mergeOp.value)) {
                    result[mergeOp.field].splice(result[mergeOp.field].indexOf(mergeOp.value), 1);
                }
            } else if (!_.isUndefined(value)) {
                result[fieldName] = value;
            }
        });
        return result;
    }

    function fromBsonValue(value, field, entity) {
        if (field.fieldType.id == 'date' && value) {
            return moment(value).format('YYYY-MM-DD'); //TODO move to REST layer?
        } else if (field.fieldType.id == 'money' && value) {
            return value.toString(10);
        } else if (field.fieldType.id == 'checkbox' && field.fieldType.storeAsArrayField) {
            return entity[field.fieldType.storeAsArrayField] &&
                _.isArray(entity[field.fieldType.storeAsArrayField]) &&
                entity[field.fieldType.storeAsArrayField].indexOf(field.name) != -1
        } else if (field.fieldType.id == 'password') {
            return '';
        }
        return value;
    }

    function toBsonValue(value, field, entity) {
        if (field.fieldType.id == 'date' && value) {
            if (_.isDate(value)) {
                return value;
            }
            return moment(value, 'YYYY-MM-DD').toDate(); //TODO move to REST layer?
        } else if (field.fieldType.id == 'reference' && value) {
            return {
                id: toMongoId(value.id),
                name: value.name
            }
        } else if (field.fieldType.id == 'money' && value) {
            return mongo.Long.fromString(value.toString());
        } else if (field.fieldType.id == 'checkbox' && field.fieldType.storeAsArrayField && !_.isUndefined(value)) {
            return value ? {
                $$push: {
                    field: field.fieldType.storeAsArrayField,
                    value: field.name
                }
            } : {
                $$pull: {
                    field: field.fieldType.storeAsArrayField,
                    value: field.name
                }
            };
        } else if (field.fieldType.id == 'password' && value) {
            return service.passwordHash(entity.id, value);
        }
        return value;
    }

    service.passwordHash = function (objectId, password) {
        var hash = crypto.createHmac('sha1', objectId.toString());
        hash.update(password, 'utf8');
        return hash.digest('hex');
    };

    service.createFile = function (fileName, readableStream) {
        var fileId = new mongo.ObjectID();
        var gridStore = new GridStore(db, fileId, fileName, "w");
        var open = Q.nfbind(gridStore.open.bind(gridStore));
        return open().then(function (store) {
            var write = Q.nfbind(store.write.bind(store));
            var writeChain = Q(null);
            readableStream.on('data', function (chunk) {
                writeChain = writeChain.then(function () {
                    return write(chunk);
                });
            });
            var deferredEnd = Q.defer();
            readableStream.on('end', function () {
                writeChain.then(function (store) {
                    var close = Q.nfbind(store.close.bind(store));
                    return close().then(function () {
                        deferredEnd.resolve(fileId);
                    }, function (err) {
                        deferredEnd.reject(err);
                    });
                })
            });
            readableStream.on('error', function (err) {
                deferredEnd.reject(err);
            });
            return deferredEnd.promise;
        });
    };

    service.getFile = function (fileId) {
        var gridStore = new GridStore(db, toMongoId(fileId), "r");
        var open = Q.nfbind(gridStore.open.bind(gridStore));
        return open().then(function (store) {
            return {fileName: store.filename, stream: store.stream(true)};
        });
    };

    service.removeFile = function (fileId) { //TODO enable file removing when file owning security checks will be ready
        var gridStore = new GridStore(db, toMongoId(fileId), "r");
        return Q.nfbind(gridStore.unlink.bind(gridStore))();
    };

    var entityListeners = {};

    service.addEntityListener = function (table, listener) {
        if (!entityListeners[table.tableName]) {
            entityListeners[table.tableName] = [];
        }
        entityListeners[table.tableName].push(listener);
    };

    return service;
};