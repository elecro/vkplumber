# VkPlumber

Utility to examine SPIRV vertex shader input attributes
and generate `VkPipelineVertexInputStateCreateInfo` based on user specified
buffer requirements.

## Usage:

#### To examine input layouts

```bash
$ node vkplumber.js <input.spv>
```

Will return a format like:

```bash
//...
Layouts:
{
  '0': {
    location: 0,
    type: {
      name: 'Vector',
      size: 12,
      baseSize: 4,
      baseType: 'Float32',
      baseCount: 3
    }
  },
  '1': {
    //...
  },
  //...
}
```

#### To generate Vulkan structures

```bash
$ node vkplumber.js <input.spv> input=[0,1,...] [input=2] [input=...]
```

Example usage:
```bash
$ node vkplumber.js <input.spv> input=0,1 input=2
```

* `input=0,1` will mean that input location 0 and 1 should be in a single buffer.
* `input=2` specifies that the location 2 is in a different buffer.

Note: the order of arguments arg important! `input=0,1` is different to `input=1,0`.
The order specifes the element layout in the buffer.
