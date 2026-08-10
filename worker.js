// Worker loaded as an ES Module
import { createOpenSCAD } from 'https://cdn.jsdelivr.net/npm/openscad-wasm@0.0.4/openscad.js';

// Signal to main thread that the module script is loaded
postMessage({ type: 'ready' });

self.onmessage = async function (e) {
    if (e.data.type === 'render') {
        try {
            // 1. Create a fresh WASM instance per render call to prevent
            // C++ global state / static variable corruption on repeated main() calls.
            const app = await createOpenSCAD();
            const instance = app.getInstance();

            // 2. Write the dynamic SCAD script to the virtual filesystem
            instance.FS.writeFile('/input.scad', e.data.script);

            // 3. Execute OpenSCAD compilation
            // (Removed '--enable=manifold' since this WASM build doesn't support it)
            instance.callMain(['/input.scad', '-o', '/output.stl']);

            // 4. Read the generated binary STL
            const outputData = instance.FS.readFile('/output.stl');

            // 5. Extract underlying ArrayBuffer
            const buffer = outputData.buffer.slice(
                outputData.byteOffset,
                outputData.byteOffset + outputData.byteLength
            );

            // 6. Send back to main thread (transferring buffer ownership)
            postMessage({ type: 'success', stl: buffer }, [buffer]);
        } catch (error) {
            postMessage({ type: 'error', error: error.toString() });
        }
    }
};