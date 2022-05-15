# VkPlumber

Utility to examine SPIRV vertex shader input attributes, descriptor information
and generate related Vulkan code based on user specified buffer requirements.

## Usage:

#### To examine input layouts

```bash
$ node vkplumber.js <input.spv>
```

Will return a format like:

```bash
//...
Entry: 'main'
 Function: %4
 Interface:
  Input:
   Location 0: in *vec<Float32, 2> inUV
  Output:
   Location 0: out *vec<Float32, 4> outFragColor

Uniforms:
 (set: 0 binding: 1) sampler2D varName: samplerColor (size: 2)
 (set: 0 binding: 0) struct varName: ubo (size: 8)
   {
         Float32 blurScale,
         Float32 blurStrength,
   }
```

#### To generate Vulkan structures

```bash
$ node vkplumber.js <input.spv> [input=0,1,...] [input=2] [input=...] [descriptors]
```

Example usage:
```bash
$ node vkplumber.js <input.spv> input=0,1 input=2 descriptors
```

* `input=0,1` will mean that input location 0 and 1 should be in a single buffer.
* `input=2` specifies that the location 2 is in a different buffer.
* `desciptors` will generated descriptor pool, descriptor set, descriptor set layout creation calls. These should be updated before using!

Note: the order of arguments arg important! `input=0,1` is different to `input=1,0`.
The order specifes the element layout in the buffer.
