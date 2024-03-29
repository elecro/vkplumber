const console = require('console');
const fs = require('fs');

function loadJson(filename) {
    const data = fs.readFileSync(filename, { encoding: 'latin1', flag: 'r' });
    return JSON.parse(data);
}

function reverseDict(dict) {
    const entrySet = Object.entries(dict);

    const result = [];
    for(var idx = 0; idx < entrySet.length; idx++) {
        result[entrySet[idx][1]] = entrySet[idx][0];
    }

    return result;
}

function processSpirvJson(data) {
    let info = {};
    const enums = data.spv.enum;
    for (var idx = 0; idx < enums.length; idx++) {
        switch (enums[idx].Name) {
            case 'Op': {
                info.opNameToValue = enums[idx].Values;
                info.opValueToName = reverseDict(enums[idx].Values);
                break;
            }
            case 'Decoration': {
                info.decorationNameToValue = enums[idx].values;
                info.decorationValueToName = reverseDict(enums[idx].Values);
            }
        }
    }

    return info;
}

function loadSpirvFile(filename) {
    const data = fs.readFileSync(filename, { encoding: null, flag: 'r' });
    const uintarray = new Uint8Array(data)
    return new Uint32Array(uintarray.buffer);
}

function dumpSpirvHex(data) {
    for (var idx = 0; idx < data.length; idx++) {
        console.log(data[idx].toString(16));
    }
}

function parseHeader(data) {
    return {
        magicnumber: data[0],
        version: data[1],
        generator: data[2],
        bound: data[3],
    }
}

function hexString(value) {
    return '0x' + value.toString(16).padStart(8, '0') ;
}

function dumpHeaderInfo(header, logCallback) {
    logCallback("Magic Number : " + hexString(header.magicnumber));
    logCallback("Version : " + hexString(header.version));
}

class Spirv {
    constructor(data, spirvInfo) {
        this.data = data;
        this.currentInsnIdx = 5; // header is 5 word big

        this.spirvInfo = spirvInfo || {};
    }

    getInsnSize() {
        return this.data[this.currentInsnIdx] >> 16;
    }

    getInsn() {
        const size = this.getInsnSize();
        const opcode = this.data[this.currentInsnIdx] & 0xFFFF;

        const argCount = size - 1;
        const slice = this.data.slice(this.currentInsnIdx + 1, this.currentInsnIdx + size);
        return {
            opcode: opcode,
            name: this.spirvInfo.opValueToName[opcode],
            size: this.getInsnSize(),
            args: slice,
        };
    }

    next() {
        const size = this.getInsnSize();
        this.currentInsnIdx += size;
        return this.currentInsnIdx < this.data.length;
    }
}

function decodeString(buffer, startIdx) {
    const chars = []
    for (var idx = startIdx; idx < buffer.length; idx++) {
        const value = buffer[idx];
        for (var shift = 0; shift <= 24; shift += 8) {
            const ch = (value >> shift) & 0xFF;
            if (ch == 0) {
                return { text: chars.join(''), nextIdx: idx + 1 };
            }

            chars.push(String.fromCharCode(ch));
        }
    }
    return { text: chars.join(''), nextIdx: idx + 1 };
}

class SpirvModuleInfo {
    constructor(spirvInfo) {
        this.spirvInfo = spirvInfo;
        this.entryPoints = [];
        this.names = {};
        this.memberNames = {};
        this.decorations = {};
        this.types = {};
        this.variables = {};

        // variable id-s for uniforms
        this.uniformVariables = [];
    }

    addEntryPoint(name, functionId, interfaceIds, execModel) {
        this.entryPoints.push({
            name: name,
            functionId: functionId,
            interfaceIds: interfaceIds,
            execModel: execModel,
        });
    }

    addName(name, targetId) {
        this.names[targetId] = name;
    }

    addMemberName(targetId, memberIdx, text) {
        if (!(targetId in this.memberNames)) {
            this.memberNames[targetId] = [];
        }

        this.memberNames[targetId][memberIdx] = text;
    }

    addDecoration(targetId, key, args) {
        if (!(targetId in this.decorations)) {
            this.decorations[targetId] = [];
        }

        this.decorations[targetId].push({ key: key, args: args || {} });
    }

    addType(targetId, name, options) {
        this.types[targetId] = { id: targetId, name: name, options: options || null };
    }

    typeToString(typeId) {
        const type = this.types[typeId] || typeId;
        if (!type) {
            return '<unknown type>';
        }

        if (!type.options) {
            return type.name;
        }

        switch (type.options.type) {
            case 'pointer': {
                const subType = this.typeToString(type.options.baseTypeId);
                return '*' + subType;
                break;
            }
            case 'vector': {
                const subType = this.typeToString(type.options.baseTypeId);
                const count = type.options.elementCount;
                return `vec<${subType}, ${count}>`;
            }
            case 'array': {
                const subType = this.typeToString(type.options.baseTypeId);
                const count = type.options.elementCount;
                return `${subType}[${count}]`;
            }
            case 'matrix': {
                const subType = this.typeToString(type.options.baseTypeId);
                const count = type.options.elementCount;
                return `mat<${subType}, ${count}>`;
            }
            case 'struct': {
                const memberNames = this.memberNames[typeId];
                const subTypeIds = type.options.subTypeIds;
                const items = []
                for (var idx = 0; idx < subTypeIds.length; idx++) {
                    const typeStr = this.typeToString(subTypeIds[idx]);
                    const varName = memberNames && memberNames[idx] ? " " + memberNames[idx] : "";
                    items.push(typeStr + varName);
                }
                return '{ ' + items.join(',') + ' }';
            }
            case 'int':
            case 'float': {
                return type.name;
            }
        }

        return type.name + JSON.stringify(type.options);
    }

    typeBuildLayout(typeId) {
        const type = this.types[typeId];
        if (!type) {
            return {};
        }

        //console.log("-->", JSON.stringify(type));
        switch (type.options.type) {
            case 'vector': {
                const subType = this.typeBuildLayout(type.options.baseTypeId);
                const info = {
                    name: 'vector',
                    size: subType.size * type.options.elementCount,
                    baseSize: subType.size,
                    baseType: subType.name,
                    baseCount: type.options.elementCount,
                    options: type.options,
                };
                return info;
            }
            case 'array': {
                const subType = this.typeBuildLayout(type.options.baseTypeId);
                const info = {
                    name: 'array',
                    size: subType.size * type.options.elementCount,
                    baseSize: subType.size,
                    baseType: subType.name,
                    baseCount: type.options.elementCount,
                    options: type.options,
                };
            }
            case 'matrix': {
                const subType = this.typeBuildLayout(type.options.baseTypeId);
                const info = {
                    name: 'matrix',
                    size: subType.size * type.options.elementCount,
                    baseSize: subType.size,
                    baseType: 'vector',
                    baseCount: type.options.elementCount,
                };
                return info;
            }
            case 'struct': {
                const memberNames = this.memberNames[typeId];
                const subTypeIds = type.options.subTypeIds;
                const items = []

                let totalSize = 0;
                for (var idx = 0; idx < subTypeIds.length; idx++) {
                    let subTypeInfo = this.typeBuildLayout(subTypeIds[idx]);
                    subTypeInfo.memberName = memberNames && memberNames[idx] ? memberNames[idx] : "";
                    subTypeInfo.options = this.types[subTypeIds[idx]].options;

                    totalSize += subTypeInfo.size;
                    items.push(subTypeInfo);
                }
                const info = {
                    name: 'struct',
                    size: totalSize,
                    baseSize: totalSize,
                    baseType: 'struct',
                    baseCount: 1,
                    children: items,
                };
                return info;
            }
            case 'image': {
                // TODO: move to func
                let info = {
                    format: type.options.format,
                    isArray: !!type.options.isArray,
                    isMultisampled: !!type.options.isMultisampled,
                };
                switch (type.options.dimensionType) {
                    case 0: { // 1D
                        info.size = 1;
                        info.baseSize = 1;
                        info.baseType = 'image';
                        info.baseCount = 1;
                        info.suffix = '1D';
                        break;
                    }
                    case 1: { // 2D
                        info.size = 2;
                        info.baseSize = 2;
                        info.baseType = 'image';
                        info.baseCount = 1;
                        info.suffix = '2D';
                        break;
                    }
                    case 3: { // 3D
                        info.size = 3;
                        info.baseSize = 3;
                        info.baseType = 'image';
                        info.baseCount = 1;
                        info.suffix = '3D';
                        break;
                    }
                    case 4: { // Cube
                        info.size = 6;
                        info.baseSize = 1;
                        info.baseType = 'image';
                        info.baseCount = 6;
                        info.suffix = 'Cube';
                        break;
                    }
                    case 6: { // SubpassData
                        info.size = 1;
                        info.baseSize = 1;
                        info.baseType = 'subpassInput';
                        info.baseCount = 1;
                        info.suffix = 'Subpass';
                        break;
                    }
                    default: {
                        info.suffix = info.name = '<unknown img>'
                        break;
                    }
                }
                if (info.isArray) {
                    info.suffix += 'Array';
                }
                info.name = 'image' + info.suffix;
                return info;
            }

            case 'sampledimage': {
                const subType = this.typeBuildLayout(type.options.baseTypeId);
                const info = {
                    name: 'sampler' + subType.suffix,
                    size: subType.size,
                    type: subType,
                    baseType: type.options.type,
                    baseCount: 1, // TODO (used for desc generation
                };
                return info;
            }

            default: {
                const info = {
                    name: type.name,
                    size: type.options.size,
                    baseSize: type.options.size,
                    baseType: type.name,
                    baseCount: 1,
                }
                return info;
            }
        }

        return {};
    }

    addVariable(targetId, targetTypeId, storageClass) {
        this.variables[targetId] = {
            id: targetId,
            typeId: targetTypeId,
            storageClass: storageClass,
            // Constants from standard
            isInput: storageClass == 1,
            isOutput: storageClass == 3,
            isFunctionLocal: storageClass == 7,
        };

        switch (storageClass) {
            case 0: {
                this.uniformVariables.push(targetId);
                break;
            }
            case 2: { // uniform
                this.uniformVariables.push(targetId);
                break;
            }
        }
    }

    variableToString(targetId) {
        if (!(targetId in this.variables)) {
            return '<unknown variable>';
        }
        const variable = this.variables[targetId];

        const result = [];
        if (variable.isInput) { result.push('in'); }
        else if (variable.isOutput) { result.push('out'); }

        result.push(this.typeToString(variable.typeId));

        return result.join(' ');
    }

    variableTypeInfo(targetId) {
        if (!(targetId in this.variables)) {
            return {}
        }

        const variable = this.variables[targetId];
        const ptrType = this.types[variable.typeId];
        const layout = this.typeBuildLayout(ptrType.options.baseTypeId);
        //return { baseType: , baseTypeSize: , elementCount: , }
        return layout;
    }

    decorationsToString(targetId) {
        const decorations = this.decorations[targetId];
        if (!decorations) {
            return "<no decorations>";
        }

        var text = [];
        for (var idx = 0; idx < decorations.length; idx++) {
            const decor = decorations[idx];
            const name = this.spirvInfo.decorationValueToName[decor.key];

            const str = [name];
            if (decor.args) {
                str.push(...decor.args);
            }

            text.push(str.join(' '));
        }
        return text.join('');
    }

    decorationFindLocation(targetId) {
        const decorations = this.decorations[targetId];
        if (!decorations) {
            return -1;
        }

        for (var idx = 0; idx < decorations.length; idx++) {
            const decor = decorations[idx];
            const name = this.spirvInfo.decorationValueToName[decor.key];
            if (name == 'Location') {
                return decor.args[0];
            }
        }

        return -1;
    }

    getExecutionModel(execId) {
        // TODO: use it from spirv.json
        switch (execId) {
            case 0: return 'Vertex';
            case 4: return 'Fragment';
            case 6: return 'Kernel';
        }
        return '<unknown mode>'
    }

    processEntryPoints() {
        let resultList = [];
        for (var idx = 0; idx < this.entryPoints.length; idx++) {
            const entry = this.entryPoints[idx];
            let result = {
                name: entry.name,
                functionId: entry.functionId,
                execModel: this.getExecutionModel(entry.execModel),
                inputs: [],
                outputs: [],
            };

            for (var ndx = 0; ndx < entry.interfaceIds.length; ndx++) {
                const iface = entry.interfaceIds[ndx];
                const ifaceVariable = this.variables[iface];

                const iname = this.names[iface];
                const decorations = this.decorationsToString(iface);
                const type = this.variableToString(iface);

                const location = "";

                const item = {
                    name: iname,
                    type: type,
                    decorations: decorations,
                    location: this.decorationFindLocation(iface),
                    id: iface,
                    isBuiltin: !this.decorations[iface], // TODO: check this
                };
                if (ifaceVariable.isInput) {
                    result.inputs.push(item);
                } else if (ifaceVariable.isOutput) {
                    result.outputs.push(item);
                }
            }

            resultList.push(result);
        }

        return resultList;
    }

    dumpEntryPoints(logCallback) {
        const entries = this.processEntryPoints();
        for (var idx = 0; idx < entries.length; idx++) {
            const entry = entries[idx];
            logCallback(`Entry: '${entry.name}'`);
            logCallback(` Function: %${entry.functionId}`);
            logCallback(' Interface:');
            logCallback('  Input:');
            for (var ndx = 0; ndx < entry.inputs.length; ndx++) {
                const iface = entry.inputs[ndx];
                logCallback(`   ${iface.decorations}: ${iface.type} ${iface.name}`);

                //console.log(this.variableTypeInfo(iface.id));
            }
            logCallback('  Output:');
            for (var ndx = 0; ndx < entry.outputs.length; ndx++) {
                const iface = entry.outputs[ndx];
                if (!iface.isBuiltin)
                    logCallback(`   ${iface.decorations}: ${iface.type} ${iface.name}`);
            }
        }
    }

    processEntryLayouts() {
        // TODO: do we even need this?
        const entries = this.processEntryPoints();
        const result = []
        for (var idx = 0; idx < entries.length; idx++) {
            const entry = entries[idx];

            const inputLayout = {
                // (location) 0: { location: 0, layout: ... }
            };
            for (var ndx = 0; ndx < entry.inputs.length; ndx++) {
                const iface = entry.inputs[ndx];
                const layout = this.variableTypeInfo(iface.id);
                //console.log(iface.location, layout);

                inputLayout[iface.location] = {
                    location: iface.location,
                    type: layout,
                    varName: iface.name,
                }
            }
            result.push({
                name: entry.name,
                execModel: entry.execModel,
                layout: inputLayout,
            });
        }
        return result;
    }

    dumpEntryLayouts(logCallback) {
        const entryPoints = this.processEntryLayouts();
        for (var idx = 0; idx < entryPoints.length; idx++) {
            const entry = entryPoints[idx];

            logCallback(`EntryPoint: ${entry.name} [${entry.execModel}]`);
            logCallback(' Inputs:')
            for (var ndx in entry.layout) {
                const iface = entry.layout[ndx];
                const typeStr = this.typeToString(iface.type);
                logCallback(`  location ${iface.location}: ${typeStr} ${iface.varName}`);
            }
        }
    }

    getDescritorDecorators(targetId) {
        let descriptorInfo = {
            set: -1,
            binding: -1,
        };

        const decors = this.decorations[targetId];
        for (var idx = 0; idx < decors.length; idx++) {
            const decor = decors[idx];
            const name = this.spirvInfo.decorationValueToName[decor.key];
            switch (name) {
                case 'DescriptorSet': descriptorInfo.set = decor.args[0]; break;
                case 'Binding': descriptorInfo.binding = decor.args[0]; break;
            }
        }

        return descriptorInfo;
    }

    processUniforms() {
        const descriptors = [];
        for (var idx = 0; idx < this.uniformVariables.length; idx++) {
            const variable = this.variables[ this.uniformVariables[idx] ];
            //const decors = this.decorations[ variable.id ];
            const descriptorInfo = this.getDescritorDecorators(variable.id);

            const layout = this.variableTypeInfo(variable.id);
            //console.log(layout);
            //console.log(this.typeToString(variable.typeId));

            descriptors.push({
                set: descriptorInfo.set,
                binding: descriptorInfo.binding,

                type: layout.name,
                varName: this.names[variable.id],
                layout: layout,
                variableId: variable.id,
            });
        }
        descriptors.sort((left, right) => left.set - right.set || left.binding - right.binding);

        return descriptors;
    }

    dumpUniforms(logCallback) {
        logCallback('Uniforms:');
        const descriptors = this.processUniforms();
        //console.log(descriptors[0]);
        for (var idx = 0; idx < descriptors.length; idx++) {
            const desc = descriptors[idx];
            logCallback(` (set: ${desc.set} binding: ${desc.binding}) ${desc.type} varName: ${desc.varName} (size: ${desc.layout.size})`);

            if (desc.layout.children) {
                logCallback('{'.padStart(4));
                desc.layout.children.forEach(type => {
                    const typeStr = this.typeToString(type);
                    logCallback(' '.padStart(4 + 4), typeStr, type.memberName + ",");
                });
                logCallback('}'.padStart(4));
            }
        }
    }
};

function processSpirvContents(data, spirvInfo, logCallback) {
    const info = new SpirvModuleInfo(spirvInfo);
    const mod = new Spirv(data, spirvInfo);

    while (mod.next()) {
        //console.log(mod.getInsn());
        const insn = mod.getInsn();

        switch (insn.name) {
            case 'OpExtInstImport': {
                const resultId = insn.args[0];
                const { text, nextIdx } = decodeString(insn.args, 1);
                logCallback(`%${resultId} = OpExtInstImport: '${text}'`);
                break;
            }

            case 'OpEntryPoint': {
                const resultFuncId = insn.args[1];
                const execModel = insn.args[0];
                const { text, nextIdx } = decodeString(insn.args, 2);
                const interfaceValues = insn.args.slice(nextIdx);
                logCallback(`OpEntryPoint: ${execModel} %${resultFuncId} '${text}' interfaces: %[${interfaceValues}]`);
                info.addEntryPoint(text, resultFuncId, interfaceValues, execModel);
                break;
            }

            case 'OpName': {
                const targetId = insn.args[0];
                const { text, nextId } = decodeString(insn.args, 1);
                logCallback(`OpName: %${targetId} == '${text}'`);
                info.addName(text, targetId);
                break;
            }

            case 'OpMemberName': {
                const targetId = insn.args[0];
                const memberIdx = insn.args[1];
                const { text, nextId } = decodeString(insn.args, 2);

                info.addMemberName(targetId, memberIdx, text);
                break;
            }

            case 'OpDecorate': {
                const targetId = insn.args[0];
                const decorationKey = insn.args[1];
                const args = insn.args.slice(2);
                logCallback(`OpDecorate: %${targetId} ${decorationKey} ${args}`);
                info.addDecoration(targetId, decorationKey, args);
                break;
            }

            case 'OpTypeVoid': {
                const targetId = insn.args[0];
                logCallback(`%${targetId} = OpTypeVoid`);
                info.addType(targetId, 'Void', { type: 'void', size: 0, elementCount: 1 });
                break;
            }

            case 'OpTypeInt': {
                const targetId = insn.args[0];
                const width = insn.args[1];
                const signed = insn.args[2];
                logCallback(`%${targetId} = OpTypeInt ${width} ${signed}`);

                const typeName = signed ? 'Int' : 'UInt';
                info.addType(targetId, typeName + width, { type: 'int', size: 4, elementCount: 1});
                break;
            }

            case 'OpTypeFloat': {
                const targetId = insn.args[0];
                const width = insn.args[1];
                logCallback(`%${targetId} = OpTypeFloat ${width}`);
                info.addType(targetId, 'Float' + width, { type: 'float', size: 4, elementCount: 1 });
                break;
            }

            case 'OpTypeVector': {
                const targetId = insn.args[0];
                const baseTypeId = insn.args[1];
                const elementCount = insn.args[2];
                logCallback(`%${targetId} = OpTypeVector %${baseTypeId} ${elementCount}`);

                info.addType(targetId, 'Vector', { type: 'vector', size: -1, elementCount: elementCount, baseTypeId: baseTypeId });
                break;
            }

            case 'OpTypeArray': {
                const targetId = insn.args[0];
                const baseTypeId = insn.args[1];
                const length = insn.args[2];
                logCallback(`%${targetId} = OpTypeArray %${baseTypeId} ${length}`);

                info.addType(targetId, 'Array', { type: 'array', size: -1, elementCount: length, baseTypeId: baseTypeId });
                break;
            }

            case 'OpTypeMatrix': {
                const targetId = insn.args[0];
                const baseTypeId = insn.args[1];
                const elementCount = insn.args[2]; // column count
                logCallback(`%${targetId} = OpTypeMatrix %${baseTypeId} ${elementCount}`);

                info.addType(targetId, 'Matrix', { type: 'matrix', size: -1, elementCount: elementCount, baseTypeId: baseTypeId });
                break;
            }

            case 'OpTypeImage': {
                const targetId = insn.args[0];
                const sampledTypeId = insn.args[1];
                const dimensionType = insn.args[2];
                const depth = insn.args[3];
                const isArray = insn.args[4];
                const isMultisampled = insn.args[5];
                const isSampled = insn.args[6];
                const format = insn.args[7];
                logCallback(`%${targetId} = OpTypeImage %${sampledTypeId} ${dimensionType} ${depth} ${isArray} ${isMultisampled} ${isSampled} ${format}`);

                info.addType(targetId, 'Image', {
                    type: 'image', size: -1, elementCount: 1, baseTypeId: sampledTypeId,
                    //sampledTypeId: sampledTypeId,
                    dimensionType: dimensionType,
                    depth: depth,
                    isArray: isArray,
                    isMultisampled, isMultisampled,
                    isSampled: isSampled,
                    format: format,
                });
                break;
            }

            case 'OpTypeSampledImage': {
                const targetId = insn.args[0];
                const baseTypeId = insn.args[1];
                logCallback(`%${targetId} = OpTypeSampledImage %${baseTypeId}`);

                info.addType(targetId, 'SampledImage', { type: 'sampledimage', size: -1, elementCount: 1, baseTypeId: baseTypeId });
                break;
            }

            case 'OpTypePointer': {
                const targetId = insn.args[0];
                const storageClass = insn.args[1];
                const targetTypeId = insn.args[2];
                logCallback(`%${targetId} = OpTypePointer ${storageClass} %${targetTypeId}`);

                info.addType(targetId, 'Pointer', { type: 'pointer', storageClass: storageClass, size: -1, elementCount: 1, baseTypeId: targetTypeId });
                break;
            }

            case 'OpTypeStruct': {
                const targetId = insn.args[0];
                const subTypeIds = insn.args.slice(1);

                info.addType(targetId, 'Struct', { type: 'struct', size: -1, elementCount: subTypeIds.length, subTypeIds: subTypeIds });
                break;
            }

            case 'OpVariable': {
                const targetTypeId = insn.args[0];
                const targetId = insn.args[1];
                const storageClass = insn.args[2];
                logCallback(`%${targetId} = OpVariable %${targetTypeId} ${storageClass}`);

                //info.addType(targetId, 'Pointer', { type: 'pointer', storageClass: storageClass, targetTypeId: targetTypeId });
                info.addVariable(targetId, targetTypeId, storageClass);
                break;
            }
        }
    }
    return info;
}

function parseLayoutConfig(args) {
    // input=0,1  input=2,
    // input=0   input=1  input=2
    const layoutRequirements = {
        locations: [],
        /*
            0: { location: 0, buffer: 0, }.
            1: { location: 1, buffer: 0, }
            2: { location: 2, buffer: 1, }
        */

        buffers: [],
        /*
            0: [ { location: 0 }, { location: 1 } ]
        */
    };
    let bufferIdx = 0;
    for (var idx = 0; idx < args.length; idx++) {
        const arg = args[idx];
        const items = arg.split("=");

        switch (items[0]) {
            case 'input': {
                const entries = items[1].split(',');
                const bufferConfig = [];
                for (var ndx = 0; ndx < entries.length; ndx++) {
                    layoutRequirements.locations.push({
                        location: entries[ndx],
                        buffer: bufferIdx,
                    });
                    bufferConfig.push({ location: entries[ndx] });
                }
                layoutRequirements.buffers.push(bufferConfig);
                bufferIdx++;
                break;
            }
        }
    }
    if (!layoutRequirements.buffers.length) {
        return null;
    }

    return layoutRequirements;
}


function typeToFormat(type) {
    /*
    VK_FORMAT_R32_SFLOAT = 100,
    VK_FORMAT_R32G32_UINT = 101,
    VK_FORMAT_R32G32_SINT = 102,
    VK_FORMAT_R32G32_SFLOAT = 103,
    VK_FORMAT_R32G32B32_UINT = 104,
    VK_FORMAT_R32G32B32_SINT = 105,
    VK_FORMAT_R32G32B32_SFLOAT = 106,
    VK_FORMAT_R32G32B32A32_UINT = 107,
    VK_FORMAT_R32G32B32A32_SINT = 108,
    VK_FORMAT_R32G32B32A32_SFLOAT = 109,
    */
    const mapping = {
        'Float32': { // base type
            // count:
            1: "VK_FORMAT_R32_SFLOAT",
            2: "VK_FORMAT_R32G32_SFLOAT",
            3: "VK_FORMAT_R32G32B32_SFLOAT",
            4: "VK_FORMAT_R32G32B32A32_SFLOAT",
        },
    }
    return mapping[type.baseType][type.baseCount];
}

function calculateOffsetString(currentDesc, previousDesc) {
    if (!('offset' in previousDesc)) {
        return '0';   // no previous attribute desc info
    }

    const typeMapping = {
        "Float32": "float",
        "Float64": "double",
        "Int32": "int32_t",
        "UInt32": "uint32_t",
    };

    const baseType = typeMapping[previousDesc.type.baseType];

    return `${previousDesc.offset} + (sizeof(${baseType}) * ${previousDesc.type.baseCount})`;
}

function buildLayoutConfig(reqs, entry) {
    let bindingIdx = 0;

    const bindigDescriptors = [];
    const attrDescriptors = [];
    for (var rdx = 0; rdx < reqs.buffers.length; rdx++) {
        const bufferCfg = reqs.buffers[rdx];
        //console.log(bufferCfg);

        let prevDesc = {};

        for (var ndx = 0; ndx < bufferCfg.length; ndx++) {
            const targetLoc = entry.layout[bufferCfg[ndx].location];
            const attributeDescription = {
                binding: bindingIdx,
                location: targetLoc.location,
                format: typeToFormat(targetLoc.type),
                type: targetLoc.type,
                offset: -1, // will be calculated below
            };
            attributeDescription.offset = calculateOffsetString(attributeDescription, prevDesc);
            prevDesc = attributeDescription;
            attrDescriptors.push(attributeDescription);
        }

        const totalOffset = calculateOffsetString(attrDescriptors[attrDescriptors.length - 1], prevDesc);
        const bindingDesc = {
            binding: bindingIdx++,
            stride: totalOffset,
            inputRate: 'VK_VERTEX_INPUT_RATE_VERTEX',
        };
        bindigDescriptors.push(bindingDesc);
    }

    return { attributes: attrDescriptors, bindings: bindigDescriptors };
}

function writeVkPipelineVertexInputStateCreateInfo(config) {
    // VkVertexInputBindingDescription:
    let resultString = [];
    const padding = 60;

    const bindingCount = config.bindings.length;
    resultString.push(`VkVertexInputBindingDescription inputBindings[${bindingCount}] = {`);
    for (var idx = 0; idx < bindingCount; idx++) {
        const binding = config.bindings[idx];
        resultString.push('   {');
        resultString.push(`       ${binding.binding},`.padEnd(padding) + "// binding");
        resultString.push(`       ${binding.stride},`.padEnd(padding) + "// stride");
        resultString.push(`       ${binding.inputRate},`.padEnd(padding) + "// inputRate");
        resultString.push('   },');
    }
    resultString.push('};');
    resultString.push('');

    //VkVertexInputAttributeDescription
    const attrCount = config.attributes.length;
    resultString.push(`VkVertexInputAttributeDescription inputAttributes[${attrCount}] = {`);
    for (var idx = 0; idx < attrCount; idx++) {
        const attr = config.attributes[idx];
        resultString.push('   {');
        resultString.push(`       ${attr.location},`.padEnd(padding) + "// location");
        resultString.push(`       ${attr.binding},`.padEnd(padding) + "// binding");
        resultString.push(`       ${attr.format},`.padEnd(padding) + "// format");
        resultString.push(`       ${attr.offset},`.padEnd(padding) + "// offset");
        resultString.push('   },');
    }
    resultString.push('}');
    resultString.push('');

    resultString.push("VkPipelineVertexInputStateCreateInfo vertexInputInfo{};");
    resultString.push("vertexInputInfo.sType = VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO");
    resultString.push("vertexInputInfo.pNext = NULL;");
    resultString.push("vertexInputInfo.flags = 0;");
    resultString.push(`vertexInputInfo.vertexBindingDescriptionCount = ${bindingCount};`);
    resultString.push("vertexInputInfo.pVertexBindingDescriptions = &inputBindings;")
    resultString.push(`vertexInputInfo.vertexAttributeDescriptionCount = ${attrCount};`);
    resultString.push("vertexInputInfo.pVertexAttributeDescriptions = &inputAttributes;");

    return resultString.join("\n");
}

function writeStructSets(structName, setMembers) {
    let resultString = [];
    for (var idx = 0; idx < setMembers.length; idx++) {
        const entry = setMembers[idx];
        resultString.push(`${structName}.${entry.member} = ${entry.value};`);
    }

    return resultString.join("\n");
}

function writeDescriptors(descriptors) {
    //console.log(descriptors)
    let resultString = [];

    // Descriptor Pool
    // calculate descriptor pools:
    const descTypeMapping = {
        'struct': 'VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER',
        'sampledimage': 'VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER',
        'subpassInput': 'VK_DESCRIPTOR_TYPE_INPUT_ATTACHMENT',
    };
    const descTypeCount = {}
    descriptors.forEach(desc => {
        const type = descTypeMapping[desc.layout.baseType];
        if (!(type in descTypeCount)) {
            descTypeCount[type] = 0;
        }
        descTypeCount[type]++;
    });

    const poolSizeCount = Object.keys(descTypeCount).length;
    resultString.push(`VkDescriptorPoolSize poolSizes[${poolSizeCount}] = { /* adapt based on max simultaneous use */`);
    for (var type in descTypeCount) {
        resultString.push('{'.padStart(4) + ` ${type}, ${descTypeCount[type]}` + ' },');
    }
    resultString.push('};');
    resultString.push('');

    resultString.push('VkDescriptorPoolCreateInfo poolInfo{}');
    const poolInfoSetMembers = [
        { member: 'sType', value: 'VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO' },
        { member: 'pNext', value: 'NULL' },
        { member: 'flags', value: 0 },
        { member: 'maxSets', value: 1 },
        { member: 'poolSizeCount', value: poolSizeCount },
        { member: 'pPoolSizes', value: 'poolSizes' },
    ];
    resultString.push(writeStructSets('poolInfo', poolInfoSetMembers));
    resultString.push('');

    resultString.push('vkDescriptorPool descriptorPool = VK_NULL_HANDLE;');
    resultString.push('vkCreateDescriptorPool(device, &poolInfo, NULL, &descriptorPool);');
    resultString.push('');

    // Set Layout
    // TODO: allow multiple descriptorsets

    const bindingCount = descriptors.length;
    resultString.push(`VkDescriptorSetLayoutBinding bindings[${bindingCount}] = {`);
    const memberPad = ''.padStart(2 + 5);
    for (var idx = 0; idx < descriptors.length; idx++) {
        const desc = descriptors[idx];
        const type = descTypeMapping[desc.layout.baseType];

        const flags = [];
        if (type != 'VK_DESCRIPTOR_TYPE_INPUT_ATTACHMENT') {
            flags.push('VK_SHADER_STAGE_VERTEX_BIT');
        }
        flags.push('VK_SHADER_STAGE_FRAGMENT_BIT');

        resultString.push('{'.padStart(5));
        resultString.push(`${memberPad} ${desc.binding},`.padEnd(60) + '// binding');
        resultString.push(`${memberPad} ${type},`.padEnd(60) + '// descriptorType');
        resultString.push(`${memberPad} ${desc.layout.baseCount},`.padEnd(60) + '// descriptorCount');
        resultString.push(`${memberPad} ` + (flags.join(' | ') + ',').padEnd(60) +  '// stageFlags');
        resultString.push(memberPad + ' NULL'.padEnd(60) + '// pImmutableSamplers');
        resultString.push('},'.padStart(6));
    }
    resultString.push('}');
    resultString.push('');

    resultString.push('VkDescriptorSetLayoutCreateInfo descriptorSetLayoutInfo{};');
    const layoutSetMembers = [
        { member: 'sType', value: 'VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO' },
        { member: 'pNext', value: 'NULL' },
        { member: 'flags', value: 0 },
        { member: 'bindingCount', value: bindingCount },
        { member: 'pBindings',  value: 'bindingsLayout' },
    ];
    resultString.push(writeStructSets('descriptorSetLayoutInfo', layoutSetMembers));
    resultString.push('');
    resultString.push('VkDescriptorSetLayout descriptorSetLayout = VK_NULL_HANDLE;');
    resultString.push('vkCreateDescriptorSetLayout(device, &descriptorSetLayoutInfo, NULL, &descriptorSetLayout)');
    resultString.push('');


    // Allocate descriptor set based on layout
    resultString.push('VkDescriptorSetAllocateInfo descAllocInfo{};');
    const descSetMembers = [
        { member: 'sType', value: 'VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO' },
        { member: 'pNext', value: 'NULL' },
        { member: 'descriptorPool', value: 'descriptorPool' },
        { member: 'descriptorSetCount', value: 1 },
        { member: 'pSetLayouts', value: '&descriptorSetLayout' },
    ];
    resultString.push(writeStructSets('descAllocInfo', descSetMembers));
    resultString.push('');
    resultString.push('VkDescriptorSet descriptorSet = VK_NULL_HANDLE;');
    resultString.push('vkAllocateDescriptorSets(device, &descAllocInfo, &descriptorSet)');
    resultString.push('');

    // Create vkUpdateDescriptorSets calls
    const descPerType = {
        buffers: [],
        images: [],
    };
    const descWrites = [];
    for (var idx = 0; idx < descriptors.length; idx++) {
        const desc = descriptors[idx];
        const writeInfo = {
            dstSet: desc.set,
            dstBinding: desc.binding,
            dstArrayElement: 0, // TODO: support array elements
            descriptorCount: 1, // TODO: support more than one
            descriptorType: descTypeMapping[desc.layout.baseType],
            pImageInfo: 'NULL',
            pBufferInfo: 'NULL',
            pTexelBufferView: 'NULL',
        };

        switch (desc.layout.baseType) { // TODO: make it more inclusivek
            case 'struct': {
                const bufferIdx = descPerType.buffers.length;

                descPerType.buffers.push({
                    buffer: `/* TODO: VkBuffer for binding ${desc.binding} */`,
                    offset: 0,
                    range: 'VK_WHOLE_SIZE',
                });
                writeInfo.pBufferInfo = `&bufferInfos[${bufferIdx}]`;
                break;
            }
            case 'sampledimage': {
                const imageIdx = descPerType.images.length;
                descPerType.images.push({
                    sampler: `/* TODO: VkSampler for image binding ${desc.binding} */`,
                    imageView: `/* TODO: VkImageView for image binding ${desc.binding} */`,
                    imageLayout: 'VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL',
                });
                writeInfo.pImageInfo = `&imageInfos[${imageIdx}]`;
                break;
            }
            case 'subpassInput': {
                const imageIdx = descPerType.images.length;
                descPerType.images.push({
                    sampler: 'VK_NULL_HANDLE',
                    imageView: `/* TODO: VkImageView for subpass image binding ${desc.binding} */`,
                    imageLayout: 'VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL',
                });
                writeInfo.pImageInfo = `&imageInfos[${imageIdx}]`;
                break;
            }
        }

        descWrites.push(writeInfo);
    }

    if (descPerType.buffers.length) {
        resultString.push(`VkDescriptorBufferInfo bufferInfos[${descPerType.buffers.length}] = { /* TODO: check the argumnets */`);
        for (var idx = 0; idx < descPerType.buffers.length; idx++) {
            const entry = descPerType.buffers[idx];
            resultString.push(''.padStart(4) + `{ ${entry.buffer}, ${entry.offset}, ${entry.range} },`);
        }
        resultString.push('};');
    }
    if (descPerType.images.length) {
        resultString.push(`VkDescriptorImageInfo imageInfos[${descPerType.images.length}] = { /* TODO: check the arguments */`);
        for (var idx = 0; idx < descPerType.images.length; idx++) {
            const entry = descPerType.images[idx];
            resultString.push(''.padStart(4) + `{ ${entry.sampler}, ${entry.imageView}, ${entry.imageLayout} },`);
        }
        resultString.push('};');
    }

    resultString.push('');
    resultString.push(`VkWriteDescriptorSet descriptorWrite[${descWrites.length}] = {`);
    for (var idx = 0; idx < descWrites.length; idx++) {
        const write = descWrites[idx];

        resultString.push(''.padStart(4) + '{');
        resultString.push(memberPad + ' VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET,'.padEnd(60) + '// sType');
        resultString.push(memberPad + ' NULL,'.padEnd(60) + '// pNext');
        resultString.push(memberPad + ' descriptorSet, /* TODO: check this */'.padEnd(60) + '// dstSet');
        resultString.push(memberPad + ` ${write.dstBinding},`.padEnd(60) + '// dstBinding');
        resultString.push(memberPad + ` ${write.dstArrayElement},`.padEnd(60) + '// dstArrayElement');
        resultString.push(memberPad + ` ${write.descriptorCount},`.padEnd(60) + '// descriptorCount');
        resultString.push(memberPad + ` ${write.descriptorType},`.padEnd(60) + '// descriptorType');
        resultString.push(memberPad + ` ${write.pImageInfo},`.padEnd(60) + '// pImageInfo');
        resultString.push(memberPad + ` ${write.pBufferInfo},`.padEnd(60) + '// pBufferInfo');
        resultString.push(memberPad + ` ${write.pTexelBufferView},`.padEnd(60) + '// pTexelBufferView');
        resultString.push(''.padStart(4) + '},');
    }
    resultString.push('};');
    resultString.push('');
    resultString.push(`vkUpdateDescriptorSets(device, ${descWrites.length}, descriptorWrite, 0, NULL);`)

    return resultString.join('\n');
}

function dumpVertex(args, info, logCallback) {
    logCallback('Layout Req:')
    const req = parseLayoutConfig(args);
    logCallback(JSON.stringify(req));

    const layouts = info.processEntryLayouts();
    const cfg = buildLayoutConfig(req, layouts[0]);

    let resultString = [];

    resultString.push('\n//// Vertex Input:\n')
    resultString.push(writeVkPipelineVertexInputStateCreateInfo(cfg));

    resultString.push('\nvkCmdBindVertexBuffers:\n');
    resultString.push(`VkBuffer vertexBuffers[${cfg.bindings.length}] = {`);
    cfg.bindings.forEach((item) => {
        resultString.push(`    /* TODO: VkBuffer for binding: ${item.binding} */,`);
    });
    resultString.push('};');
    resultString.push(`VkDeviceSize vertexBufferOffsets[${cfg.bindings.length}] = {`);
    cfg.bindings.forEach((item) => {
        resultString.push('    0,');
    });
    resultString.push('};');
    resultString.push(`vkCmdBindVertexBuffers(cmdBuffer, 0, ${cfg.bindings.length}, vertexBuffers, vertexBufferOffsets);`);

    return resultString.join("\n");
}


if (typeof process !== "undefined") {
    const args = process.argv.slice(2);

    const spirvJson = loadJson("spirv.json");
    const spirvInfo = processSpirvJson(spirvJson);
    //dumpSpirvHex(data);

    if (args.length < 1) {
        console.log(`Usage: ${args[0]} <input.spv> [input=0,1,...] [input=2,3,...]`);
        process.exit(-1);
    }
    const targetSPV = args[0];

    const data = loadSpirvFile(targetSPV);
    const header = parseHeader(data);

    //dumpHeaderInfo(header);
    //console.log(data);

    console.log('Processed debug messages:');
    const info = processSpirvContents(data, spirvInfo, console.log);

    console.log('Processed entry points dump:');
    info.dumpEntryPoints(console.log)

    console.log('Processed uniforms dump:');
    info.dumpUniforms(console.log)

    console.log('');
    //console.log('Entrypoint Layouts:')
    //console.log(layouts);
    //info.dumpEntryLayouts()

    if (args.length > 1) {

        const uniformRequested = args.some((arg) => arg == 'descriptors');
        const vertexRequested = args.some((arg) => arg.indexOf('input') != -1);

        if (vertexRequested) { // Do we have vertex input requests?
            let vertexCallsString = dumpVertex(args, info, console.log);
            console.log(vertexCallsString);
        }

        if (uniformRequested) {
            console.log('\n//// Descriptor configuration\n');

            const descriptors = info.processUniforms();
            const descriptorCallsString = writeDescriptors(descriptors);
            console.log(descriptorCallsString);
        }
    }
}
