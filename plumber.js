const console = require('console');
const fs = require('fs');

function loadJson(filename) {
    const data = fs.readFileSync(filename, { encoding: 'latin1', flag: 'r' });
    return JSON.parse(data);
}

function reverseDict(dict) {
    const entrySet = Object.entries(dict);
    const reversed = entrySet.map(([k, v]) => [v, k]);
    return Object.fromEntries(reversed);
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

function dumpHeaderInfo(header) {
    console.log("Magic Number : " + hexString(header.magicnumber));
    console.log("Version : " + hexString(header.version));
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
        this.decorations = {};
        this.types = {};
        this.variables = {};
    }

    addEntryPoint(name, functionId, interfaceIds) {
        this.entryPoints.push({
            name: name,
            functionId: functionId,
            interfaceIds: interfaceIds,
        });
    }

    addName(name, targetId) {
        this.names[targetId] = name;
    }

    addDecoration(targetId, key, args) {
        if (!(targetId in this.decorations)) {
            this.decorations[targetId] = [];
        }

        this.decorations[targetId].push({ key: key, args: args || {} });
    }

    addType(targetId, name, options) {
        this.types[targetId] = { name: name, options: options || null };
    }

    typeToString(typeId) {
        const type = this.types[typeId];
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
            case 'int':
            case 'float': {
                return type.name;
                break;
            }
        }

        return type.name + JSON.stringify(type.options);
    }

    typeBuildLayout(typeId) {
        const type = this.types[typeId];
        if (!type) {
            return [];
        }

        //console.log("-->", JSON.stringify(type));
        const result = [];
        switch (type.options.type) {
            case 'vector': {
                const subType = this.typeBuildLayout(type.options.baseTypeId)[0];
                const info = {
                    name: type.name,
                    size: subType.size * type.options.elementCount,
                    baseSize: subType.size,
                    baseType: subType.name,
                    baseCount: type.options.elementCount,
                };
                result.push(info)
                break;
            }

            default: {
                const info = {
                    name: type.name,
                    size: type.options.size,
                    baseSize: type.options.size,
                    baseType: type.name,
                    baseCount: 1,
                }
                result.push(info);
                break;
            }
        }
        //console.log('||', JSON.stringify(result));
        return result;
    }

    addVariable(targetId, targetTypeId, storageClass) {
        this.variables[targetId] = {
            typeId: targetTypeId,
            storageClass: storageClass,
            // Constants from standard
            isInput: storageClass == 1,
            isOutput: storageClass == 3,
            isFunctionLocal: storageClass == 7,
        };
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

    processEntryPoints() {
        let resultList = [];
        for (var idx = 0; idx < this.entryPoints.length; idx++) {
            const entry = this.entryPoints[idx];
            let result = {
                name: entry.name,
                functionId: entry.functionId,
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

    dumpEntryPoints() {
        const entries = this.processEntryPoints();
        for (var idx = 0; idx < entries.length; idx++) {
            const entry = entries[idx];
            console.log(`Entry: '${entry.name}'`);
            console.log(` Function: %${entry.functionId}`);
            console.log(' Interface:');
            console.log('  Input:');
            for (var ndx = 0; ndx < entry.inputs.length; ndx++) {
                const iface = entry.inputs[ndx];
                console.log(`   ${iface.decorations}: ${iface.type} ${iface.name}`);

                //console.log(this.variableTypeInfo(iface.id));
            }
            console.log('  Output:');
            for (var ndx = 0; ndx < entry.outputs.length; ndx++) {
                const iface = entry.outputs[ndx];
                if (!iface.isBuiltin)
                    console.log(`   ${iface.decorations}: ${iface.type} ${iface.name}`);
            }
        }
    }

    processEntryLayouts() {
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
                    type: layout[0],
                }
            }
            result.push(inputLayout);
        }
        return result;
    }
};

function processSpirvContents(data, spirvInfo) {
    const info = new SpirvModuleInfo(spirvInfo);
    const mod = new Spirv(data, spirvInfo);

    while (mod.next()) {
        //console.log(mod.getInsn());
        const insn = mod.getInsn();

        switch (insn.name) {
            case 'OpExtInstImport': {
                const resultId = insn.args[0];
                const { text, nextIdx } = decodeString(insn.args, 1);
                console.log(`%${resultId} = OpExtInstImport: '${text}'`);
                break;
            }

            case 'OpEntryPoint': {
                const resultFuncId = insn.args[1];
                const execModel = insn.args[0];
                const { text, nextIdx } = decodeString(insn.args, 2);
                const interfaceValues = insn.args.slice(nextIdx);
                console.log(`OpEntryPoint: ${execModel} %${resultFuncId} '${text}' interfaces: %[${interfaceValues}]`);
                info.addEntryPoint(text, resultFuncId, interfaceValues);
                break;
            }

            case 'OpName': {
                const targetId = insn.args[0];
                const { text, nextId } = decodeString(insn.args, 1);
                console.log(`OpName: %${targetId} == '${text}'`);
                info.addName(text, targetId);
                break;
            }

            case 'OpDecorate': {
                const targetId = insn.args[0];
                const decorationKey = insn.args[1];
                const args = insn.args.slice(2);
                console.log(`OpDecorate: %${targetId} ${decorationKey} ${args}`);
                info.addDecoration(targetId, decorationKey, args);
                break;
            }

            case 'OpTypeVoid': {
                const targetId = insn.args[0];
                console.log(`%${targetId} = OpTypeVoid`);
                info.addType(targetId, 'Void', { type: 'void', size: 0, elementCount: 1 });
                break;
            }

            case 'OpTypeInt': {
                const targetId = insn.args[0];
                const width = insn.args[1];
                const signed = insn.args[2];
                console.log(`%${targetId} = OpTypeInt ${width} ${signed}`);
                const typeName = signed ? 'Int' : 'UInt';
                info.addType(targetId, typeName + width, { type: 'int', size: 4, elementCount: 1});
                break;
            }

            case 'OpTypeFloat': {
                const targetId = insn.args[0];
                const width = insn.args[1];
                console.log(`%${targetId} = OpTypeFloat ${width}`);
                info.addType(targetId, 'Float' + width, { type: 'float', size: 4, elementCount: 1 });
                break;
            }

            case 'OpTypeVector': {
                const targetId = insn.args[0];
                const baseTypeId = insn.args[1];
                const elementCount = insn.args[2];
                console.log(`%${targetId} = OpTypeVetor %${baseTypeId} ${elementCount}`);

                info.addType(targetId, 'Vector', { type: 'vector', size: -1, elementCount: elementCount, baseTypeId: baseTypeId });
                break;
            }

            case 'OpTypePointer': {
                const targetId = insn.args[0];
                const storageClass = insn.args[1];
                const targetTypeId = insn.args[2];
                console.log(`%${targetId} = OpTypePointer ${storageClass} %${targetTypeId}`);

                info.addType(targetId, 'Pointer', { type: 'pointer', storageClass: storageClass, size: -1, elementCount: 1, baseTypeId: targetTypeId });
                break;
            }

            case 'OpVariable': {
                const targetTypeId = insn.args[0];
                const targetId = insn.args[1];
                const storageClass = insn.args[2];
                console.log(`%${targetId} = OpVariable %${targetTypeId} ${storageClass}`);

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

function buildLayoutConfig(reqs, layout) {
    let bindingIdx = 0;

    const bindigDescriptors = [];
    const attrDescriptors = [];
    for (var rdx = 0; rdx < reqs.buffers.length; rdx++) {
        const bufferCfg = reqs.buffers[rdx];
        //console.log(bufferCfg);

        let prevDesc = {};

        for (var ndx = 0; ndx < bufferCfg.length; ndx++) {
            const targetLoc = layout[bufferCfg[ndx].location];
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
    const padding = 60;

    const bindingCount = config.bindings.length;
    console.log(`VkVertexInputBindingDescription inputBindings[${bindingCount}] = {`);
    for (var idx = 0; idx < bindingCount; idx++) {
        const binding = config.bindings[idx];
        console.log('   {');
        console.log(`       ${binding.binding},`.padEnd(padding), "// binding");
        console.log(`       ${binding.stride},`.padEnd(padding), "// stride");
        console.log(`       ${binding.inputRate},`.padEnd(padding), "// inputRate");
        console.log('   },');
    }
    console.log('};');
    console.log('');

    //VkVertexInputAttributeDescription
    const attrCount = config.attributes.length;
    console.log(`VkVertexInputAttributeDescription inputAttributes[${attrCount}] = {`);
    for (var idx = 0; idx < attrCount; idx++) {
        const attr = config.attributes[idx];
        console.log('   {');
        console.log(`       ${attr.location},`.padEnd(padding), "// location");
        console.log(`       ${attr.binding},`.padEnd(padding), "// binding");
        console.log(`       ${attr.format},`.padEnd(padding), "// format");
        console.log(`       ${attr.offset},`.padEnd(padding), "// offset");
        console.log('   },');
    }
    console.log('}');
    console.log('');

    console.log("VkPipelineVertexInputStateCreateInfo vertexInputInfo{};");
    console.log("vertexInputInfo.sType = VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO");
    console.log("vertexInputInfo.pNext = NULL;");
    console.log("vertexInputInfo.flags = 0;");
    console.log(`vertexInputInfo.vertexBindingDescriptionCount = ${bindingCount};`);
    console.log("vertexInputInfo.pVertexBindingDescriptions = &inputBindings;")
    console.log(`vertexInputInfo.vertexAttributeDescriptionCount = ${attrCount};`);
    console.log("vertexInputInfo.pVertexAttributeDescriptions = &inputAttributes;");
}

console.log('---');
const args = process.argv.slice(2);
console.log(args);

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

const info = processSpirvContents(data, spirvInfo);

//info.dumpEntryPoints()

console.log('Layouts:')
const layouts = info.processEntryLayouts();
console.log(layouts[0]);

if (args.length > 1) {
    console.log('Layout Req:')

    const req = parseLayoutConfig(args);
    console.log(req);

    const cfg = buildLayoutConfig(req, layouts[0]);

    console.log('\nResult:\n')
    writeVkPipelineVertexInputStateCreateInfo(cfg);
}
