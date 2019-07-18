export default context;

export {TypeResolver, resolveTypes, mapModdleContext as map, deserialize};

function TypeResolver(types, extender) {
  const {
    BpmnError,
    Definition,
    Dummy,
    ServiceImplementation,
  } = types;

  const typeMapper = {};

  typeMapper['bpmn:DataObjectReference'] = Dummy;
  typeMapper['bpmn:Definitions'] = Definition;
  typeMapper['bpmn:Error'] = BpmnError;

  if (extender) extender(typeMapper);

  return function resolve(entity) {
    const {type, behaviour = {}} = entity;

    switch (type) {
      case 'bpmn:SendTask':
      case 'bpmn:ServiceTask':
        entity.Behaviour = getBehaviourFromType(type);
        if (behaviour.implementation) {
          behaviour.Service = ServiceImplementation;
        }
        break;
      default:
        entity.Behaviour = getBehaviourFromType(type);
    }

    if (behaviour.loopCharacteristics) {
      resolve(behaviour.loopCharacteristics);
    }

    if (behaviour.eventDefinitions) {
      behaviour.eventDefinitions.forEach(resolve);
    }

    if (behaviour.ioSpecification) {
      resolve(behaviour.ioSpecification);
    }
  };

  function getBehaviourFromType(type) {
    let activityType = typeMapper[type];
    if (!activityType && type) {
      const nonPrefixedType = type.split(':').slice(1).join(':');
      activityType = types[nonPrefixedType];
    }

    if (!activityType) {
      throw new Error(`Unknown activity type ${type}`);
    }

    return activityType;
  }
}

function context(moddleContext, typeResolver) {
  const mapped = mapModdleContext(moddleContext);
  return contextApi(resolveTypes(mapped, typeResolver));
}

function deserialize(deserializedContext, typeResolver) {
  return contextApi(resolveTypes(deserializedContext, typeResolver));
}

function contextApi(mapped) {
  const {
    activities,
    dataObjects,
    definition,
    messageFlows,
    processes,
    sequenceFlows,
  } = mapped;

  return {
    id: definition.id,
    type: definition.type,
    name: definition.name,
    getActivities,
    getActivityById,
    getDataObjects,
    getDataObjectById,
    getErrorById,
    getErrors,
    getExecutableProcesses,
    getInboundSequenceFlows,
    getMessageFlows,
    getOutboundSequenceFlows,
    getProcessById,
    getProcesses,
    getSequenceFlowById,
    getSequenceFlows,
    serialize,
  };

  function serialize() {
    return JSON.stringify({
      id: definition.id,
      type: definition.type,
      name: definition.name,
      activities,
      dataObjects,
      definition,
      messageFlows,
      processes,
      sequenceFlows,
    });
  }

  function getProcessById(processId) {
    return processes.find(({id}) => id === processId);
  }

  function getProcesses() {
    return processes;
  }

  function getExecutableProcesses() {
    return processes.filter((p) => p.behaviour.isExecutable);
  }

  function getInboundSequenceFlows(activityId) {
    return sequenceFlows.filter((flow) => flow.targetId === activityId);
  }

  function getOutboundSequenceFlows(activityId) {
    return sequenceFlows.filter((flow) => flow.sourceId === activityId);
  }

  function getMessageFlows(scopeId) {
    if (scopeId) return messageFlows.filter((flow) => flow.source.processId === scopeId);
    return messageFlows;
  }

  function getSequenceFlows(scopeId) {
    if (scopeId) return sequenceFlows.filter((flow) => flow.parent.id === scopeId);
    return sequenceFlows;
  }

  function getSequenceFlowById(flowId) {
    return sequenceFlows.find(({id}) => id === flowId);
  }

  function getActivities(scopeId) {
    if (!scopeId) return activities;
    return activities.filter((activity) => activity.parent.id === scopeId);
  }

  function getDataObjects() {
    return dataObjects;
  }

  function getDataObjectById(dataObjectId) {
    return dataObjects.find(({id}) => id === dataObjectId);
  }

  function getActivityById(actvitiyId) {
    return activities.find((activity) => activity.id === actvitiyId);
  }

  function getErrorById(errorId) {
    return getActivityById(errorId);
  }

  function getErrors() {
    return getActivities().filter((a) => a.type === 'bpmn:Error');
  }
}

function resolveTypes(mappedContext, typeResolver) {
  const {
    definition,
    activities,
    dataObjects,
    messageFlows,
    processes,
    sequenceFlows,
  } = mappedContext;

  definition.Behaviour = typeResolver(definition);
  processes.forEach(typeResolver);
  activities.forEach(typeResolver);
  dataObjects.forEach(typeResolver);
  messageFlows.forEach(typeResolver);
  sequenceFlows.forEach(typeResolver);

  return mappedContext;
}

function mapModdleContext(moddleContext) {
  const {elementsById, references, rootHandler} = moddleContext;
  const refKeyPattern = /^(?!\$).+?Ref$/;

  const definition = {
    id: rootHandler.element.id,
    type: rootHandler.element.$type,
    name: rootHandler.element.name,
    targetNamespace: rootHandler.element.targetNamespace,
    exporter: rootHandler.element.exporter,
    exporterVersion: rootHandler.element.exporterVersion,
  };

  const {
    refs,
    dataInputAssociations,
    dataOutputAssociations,
    flowRefs,
  } = prepareReferences();

  const {
    activities,
    dataObjects,
    messageFlows,
    processes,
    sequenceFlows,
  } = prepareElements(definition, rootHandler.element.rootElements);

  return {
    definition,
    activities,
    dataObjects,
    messageFlows,
    processes,
    sequenceFlows,
  };

  function prepareReferences() {
    return references.reduce((result, r) => {
      const {property, element} = r;

      switch (property) {
        case 'bpmn:sourceRef': {
          const flow = upsertFlowRef(element.id, {
            id: element.id,
            $type: element.$type,
            sourceId: r.id,
            element: elementsById[element.id],
          });
          const outbound = result.sourceRefs[r.id] = result.sourceRefs[r.id] || [];
          outbound.push(flow);
          break;
        }
        case 'bpmn:targetRef': {
          const flow = upsertFlowRef(element.id, {
            targetId: r.id,
          });
          const inbound = result.targetRefs[r.id] = result.targetRefs[r.id] || [];
          inbound.push(flow);
          break;
        }
        case 'bpmn:default':
          upsertFlowRef(r.id, {isDefault: true});
          break;
        case 'bpmn:dataObjectRef':
          result.refs.push(r);
          break;
      }

      switch (element.$type) {
        case 'bpmn:OutputSet':
        case 'bpmn:InputSet': {
          break;
        }
        case 'bpmn:DataInputAssociation':
          result.dataInputAssociations.push(r);
          break;
        case 'bpmn:DataOutputAssociation':
          result.dataOutputAssociations.push(r);
          break;
      }

      return result;

      function upsertFlowRef(id, value) {
        const flow = result.flowRefs[id] = result.flowRefs[id] || {};
        Object.assign(flow, value);
        return flow;
      }
    }, {
      refs: [],
      dataInputAssociations: [],
      dataOutputAssociations: [],
      flowRefs: {},
      sourceRefs: {},
      targetRefs: {},
    });
  }

  function prepareElements(parent, elements) {
    if (!elements) return {};

    return elements.reduce((result, element) => {
      const {id, $type: type, name} = element;

      let attachedTo;
      switch (element.$type) {
        case 'bpmn:DataObjectReference':
        case 'bpmn:Message':
          break;
        case 'bpmn:Collaboration': {
          if (element.messageFlows) {
            const {messageFlows: flows} = prepareElements(parent, element.messageFlows);
            result.messageFlows = result.messageFlows.concat(flows);
          }
          break;
        }
        case 'bpmn:MessageFlow': {
          const flowRef = flowRefs[element.id];
          result.messageFlows.push({
            ...flowRef,
            id,
            type,
            name,
            parent: {
              id: parent.id,
              type: parent.type,
            },
            source: {
              processId: getElementProcessId(flowRef.sourceId),
              id: flowRef.sourceId,
            },
            target: {
              processId: getElementProcessId(flowRef.targetId),
              id: flowRef.targetId,
            },
            behaviour: {...element},
          });
          break;
        }
        case 'bpmn:DataObject': {
          result.dataObjects.push({
            id,
            name,
            type,
            parent: {
              id: parent.id,
              type: parent.type,
            },
            references: prepareDataObjectReferences(),
            behaviour: {...element},
          });
          break;
        }
        case 'bpmn:SequenceFlow': {
          const flowRef = flowRefs[element.id];
          result.sequenceFlows.push({
            id,
            name,
            type,
            parent: {
              id: parent.id,
              type: parent.type,
            },
            isDefault: flowRef.isDefault,
            targetId: flowRef.targetId,
            sourceId: flowRef.sourceId,
            behaviour: {...element},
          });
          break;
        }
        case 'bpmn:SubProcess':
        case 'bpmn:Process': {
          const bp = {
            id,
            type,
            name,
            parent: {
              id: parent.id,
              type: parent.type,
            },
            behaviour: prepareActivityBehaviour(),
          };
          if (type === 'bpmn:Process') result.processes.push(bp);
          else result.activities.push(bp);

          const subElements = prepareElements({id, type}, element.flowElements);
          if (subElements.activities) {
            result.activities = result.activities.concat(subElements.activities);
          }
          if (subElements.sequenceFlows) {
            result.sequenceFlows = result.sequenceFlows.concat(subElements.sequenceFlows);
          }
          if (subElements.dataObjects) {
            result.dataObjects = result.dataObjects.concat(subElements.dataObjects);
          }

          break;
        }
        case 'bpmn:BoundaryEvent': {
          attachedTo = spreadRef(element.attachedToRef);
          result.activities.push(prepareActivity({attachedTo}));
          break;
        }
        case 'bpmn:SendTask':
        case 'bpmn:ServiceTask': {
          result.activities.push(prepareActivity());
          break;
        }
        default: {
          result.activities.push(prepareActivity());
        }
      }

      return result;

      function prepareActivity(behaviour) {
        return {
          id,
          type,
          name,
          parent: {
            id: parent.id,
            type: parent.type,
          },
          behaviour: prepareActivityBehaviour(behaviour),
        };
      }

      function prepareActivityBehaviour(behaviour) {
        const resources = element.resources && element.resources.map(mapResource);

        return {
          ...behaviour,
          ...element,
          eventDefinitions: element.eventDefinitions && element.eventDefinitions.map(mapActivityBehaviour),
          loopCharacteristics: element.loopCharacteristics && mapActivityBehaviour(element.loopCharacteristics),
          ioSpecification: element.ioSpecification && mapActivityBehaviour(element.ioSpecification),
          resources,
        };
      }

      function prepareDataObjectReferences() {
        const objectRefs = refs.filter((objectRef) => objectRef.id === element.id);

        return objectRefs.map((objectRef) => {
          return {
            id: objectRef.element.id,
            type: objectRef.element.$type,
            behaviour: {...objectRef.element},
          };
        });
      }
    }, {
      activities: [],
      dataObjects: [],
      messageFlows: [],
      processes: [],
      sequenceFlows: [],
    });
  }

  function getElementProcessId(elementId) {
    const bp = rootHandler.element.rootElements.find((e) => e.$type === 'bpmn:Process' && e.flowElements.find((ce) => ce.id === elementId));
    return bp.id;
  }

  function mapResource(resource) {
    if (!resource) return;

    const {$type: type, resourceAssignmentExpression} = resource;

    return {
      type,
      expression: resourceAssignmentExpression.expression && resourceAssignmentExpression.expression.body,
      behaviour: {...resource},
    };
  }

  function mapActivityBehaviour(ed) {
    if (!ed) return;

    const {$type: type} = ed;
    let behaviour = {...ed};

    const keys = Object.getOwnPropertyNames(ed);
    for (const key of keys) {
      if (refKeyPattern.test(key)) behaviour[key] = spreadRef(ed[key]);
    }

    switch (type) {
      case 'bpmn:ConditionalEventDefinition': {
        behaviour.expression = behaviour.condition && behaviour.condition.body;
        break;
      }
      case 'bpmn:InputOutputSpecification': {
        behaviour = prepareIoSpecificationBehaviour(ed);
        break;
      }
      case 'bpmn:MultiInstanceLoopCharacteristics': {
        behaviour.loopCardinality = ed.loopCardinality && ed.loopCardinality.body;
        behaviour.completionCondition = ed.completionCondition && ed.completionCondition.body;
        break;
      }
      case 'bpmn:TimerEventDefinition': {
        behaviour.timeDuration = ed.timeDuration && ed.timeDuration.body;
        break;
      }
    }

    return {
      type,
      behaviour,
    };
  }

  function prepareIoSpecificationBehaviour(ioSpecificationDef) {
    const {dataInputs, dataOutputs} = ioSpecificationDef;

    return {
      dataInputs: dataInputs && dataInputs.map((dataDef) => {
        return {
          ...dataDef,
          type: dataDef.$type,
          behaviour: getDataInputBehaviour(dataDef.id),
        };
      }),
      dataOutputs: dataOutputs && dataOutputs.map((dataDef) => {
        return {
          ...dataDef,
          type: dataDef.$type,
          behaviour: getDataOutputBehaviour(dataDef.id),
        };
      }),
    };
  }

  function getDataInputBehaviour(dataInputId) {
    const target = dataInputAssociations.find((assoc) => assoc.property === 'bpmn:targetRef' && assoc.id === dataInputId && assoc.element);
    const source = target && dataInputAssociations.find((assoc) => assoc.property === 'bpmn:sourceRef' && assoc.element && assoc.element.id === target.element.id);

    return {
      association: {
        source: source && {...source, dataObject: getDataObjectRef(source.id)},
        target: target && {...target},
      },
    };
  }

  function getDataObjectRef(dataObjectReferenceId) {
    const dataObjectRef = refs.find((dor) => dor.element && dor.element.id === dataObjectReferenceId);
    if (!dataObjectRef) return;
    return {...dataObjectRef};
  }

  function getDataOutputBehaviour(dataOutputId) {
    const source = dataOutputAssociations.find((assoc) => assoc.property === 'bpmn:sourceRef' && assoc.id === dataOutputId && assoc.element);
    const target = source && dataOutputAssociations.find((assoc) => assoc.property === 'bpmn:targetRef' && assoc.element && assoc.element.id === source.element.id);

    return {
      association: {
        source: source && {...source},
        target: target && {...target, dataObject: getDataObjectRef(target.id)},
      },
    };
  }

  function spreadRef(ref) {
    if (!ref) return;
    const {id, $type: type, name} = ref;
    return {id, type, name};
  }
}
