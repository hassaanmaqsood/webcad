import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import GUI from 'lil-gui';


import { cpp } from 'https://esm.sh/@codemirror/lang-cpp@6.0.2'; // OpenSCAD uses C++ style syntax
import { oneDark } from 'https://esm.sh/@codemirror/theme-one-dark@6.1.2';
import { basicSetup } from "https://esm.sh/codemirror@6.0.1";
import { EditorView, keymap, Decoration, MatchDecorator, ViewPlugin } from "https://esm.sh/@codemirror/view";
import { EditorState } from "https://esm.sh/@codemirror/state";
import { indentWithTab } from "https://esm.sh/@codemirror/commands";
import { StreamLanguage } from "https://esm.sh/@codemirror/language";

import { parseScadParams, setLineValue, paramToLiteral } from './params.js';

// --- Default Parametric Model Script ---
const initialScript = `/* [Dimensions] */
// Width of the main block
width = 30; // [10:1:80]

// Depth of the main block
depth = 30; // [10:1:80]

// Height of the main block
height = 15; // [5:1:50]

/* [Hole Settings] */
// Include center hole
show_hole = true;

// Hole Radius
hole_radius = 6; // [2:0.5:20]



// --- Geometry Construction ---
difference() {
    cube([width, depth, height], center=true);
    if (show_hole) {
        cylinder(h=height + 2, r=hole_radius, center=true);
    }
}

$fn = 32;
`;

// --- 1. Three.js Setup ---
const container = document.getElementById('canvas-container');
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 1000);
camera.position.set(60, 60, 60);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.setPixelRatio(window.devicePixelRatio);
container.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

scene.add(new THREE.AmbientLight(0x777777));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
dirLight.position.set(50, 100, 50);
scene.add(dirLight);

const material = new THREE.MeshNormalMaterial({ color: 0x00d2ff, roughness: 0.3, metalness: 0.2 });
let currentMesh = null;

function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
}
animate();

window.addEventListener('resize', () => {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
});

// --- 2. Worker Bridge & Queueing ---
const worker = new Worker('worker.js', { type: 'module' });
const stlLoader = new STLLoader();
let isRendering = false;
let pendingScript = null;

worker.onmessage = function (e) {
    if (e.data.type === 'ready') {
        document.getElementById('loading').style.display = 'none';
        triggerRender(editorView.state.doc.toString());
    } else if (e.data.type === 'success') {
        const geometry = stlLoader.parse(e.data.stl);
        geometry.computeVertexNormals();
        geometry.center();

        if (currentMesh) {
            scene.remove(currentMesh);
            currentMesh.geometry.dispose();
        }

        currentMesh = new THREE.Mesh(geometry, material);
        currentMesh.rotation.x = -Math.PI / 2; // OpenSCAD Z-up to Three.js Y-up
        scene.add(currentMesh);

        isRendering = false;
        if (pendingScript) {
            const next = pendingScript;
            pendingScript = null;
            triggerRender(next);
        }
    } else if (e.data.type === 'error') {
        console.error("OpenSCAD WASM Error:", e.data.error);
        isRendering = false;
    }
};

function queueRender(script) {
    if (!isRendering) triggerRender(script);
    else pendingScript = script;
}

function triggerRender(script) {
    isRendering = true;
    worker.postMessage({ type: 'render', script });
}

// --- 3. Dynamic GUI Sync Engine ---
let gui = new GUI({ container: document.getElementById('viewport-container'), title: 'OpenSCAD Parameters' });
gui.domElement.style.position = 'absolute';
gui.domElement.style.top = '10px';
gui.domElement.style.right = '10px';

let isUpdatingFromGUI = false;

function rebuildGUI() {
    gui.destroy();
    gui = new GUI({ container: document.getElementById('viewport-container'), title: 'OpenSCAD Parameters' });
    gui.domElement.style.position = 'absolute';
    gui.domElement.style.top = '10px';
    gui.domElement.style.right = '10px';

    const script = editorView.state.doc.toString();
    const { params, groupOrder } = parseScadParams(script);

    const folderMap = {};
    groupOrder.forEach(group => {
        folderMap[group] = gui.addFolder(group);
    });

    params.forEach(param => {
        const folder = folderMap[param.group] || gui;
        const state = { [param.name]: param.value };

        let controller = null;

        if (param.type === 'slider') {
            controller = folder.add(state, param.name, param.min, param.max, param.step);
        } else if (param.type === 'checkbox') {
            controller = folder.add(state, param.name);
        } else if (param.type === 'dropdown') {
            const optionsObj = {};
            param.options.forEach(opt => { optionsObj[opt.label] = opt.value; });
            controller = folder.add(state, param.name, optionsObj);
        } else {
            controller = folder.add(state, param.name);
        }

        if (param.description) {
            controller.name(`${param.name} (${param.description})`);
        }

        controller.onChange((newValue) => {
            param.value = newValue;
            const newLiteral = paramToLiteral(param);

            // Read current code, modify the exact line index, and replace CM6 editor state
            const currentLines = editorView.state.doc.toString().split('\n');
            const updatedLines = setLineValue(currentLines, param.lineIndex, newLiteral);
            const updatedScript = updatedLines.join('\n');

            isUpdatingFromGUI = true;
            editorView.dispatch({
                changes: { from: 0, to: editorView.state.doc.length, insert: updatedScript }
            });
            isUpdatingFromGUI = false;

            queueRender(updatedScript);
        });
    });
}

// --- 4. CodeMirror Setup with Debounced Change Listener ---
let debounceTimer = null;

const editorView = new EditorView({
    doc: initialScript,
    extensions: [
        basicSetup,
        cpp(),
        oneDark,
        EditorView.updateListener.of((update) => {
            if (update.docChanged && !isUpdatingFromGUI) {
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => {
                    const script = editorView.state.doc.toString();
                    rebuildGUI();
                    queueRender(script);
                }, 300);
            }
        })
    ],
    parent: document.getElementById('editor')
});

// Initial GUI build from standard script
rebuildGUI();