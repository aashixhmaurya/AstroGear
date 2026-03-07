function gcd(a, b) {
    return !b ? a : gcd(b, a % b);
}

function lcm(a, b) {
    return (a * b) / gcd(a, b);
}

let gears = [];
let nextGearId = 0;
let selectedGearId = null;

let isPlaying = true;
let isFrozen = false;
let baseRpm = 10;
let globalTime = 0;
let lastTime = performance.now();

let isEditMode = false;
let isDragging = false;
let draggedGear = null;
let raycaster = new THREE.Raycaster();
let mouse = new THREE.Vector2();
let dragPlane = new THREE.Plane();
let planeIntersect = new THREE.Vector3();
let dragOffset = new THREE.Vector3();

let showGrid = true;
let showLabels = true;

const wrapper = document.getElementById('canvas-wrapper');
const container = document.getElementById('canvas-container');
const labelsContainer = document.getElementById('labels-container');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf8fafc);

const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 1000);
camera.position.set(0, -35, 45);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
container.appendChild(renderer.domElement);

const controls = new THREE.OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.screenSpacePanning = true;
controls.maxPolarAngle = Math.PI / 2 + 0.1;

const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
scene.add(ambientLight);

const dirLight = new THREE.DirectionalLight(0xffffff, 0.5);
dirLight.position.set(20, 40, 20);
dirLight.castShadow = true;
dirLight.shadow.camera.top = 50;
dirLight.shadow.camera.bottom = -50;
dirLight.shadow.camera.left = -50;
dirLight.shadow.camera.right = 50;
dirLight.shadow.mapSize.width = 2048;
dirLight.shadow.mapSize.height = 2048;
dirLight.shadow.bias = -0.001;
scene.add(dirLight);

const backLight = new THREE.DirectionalLight(0xe2e8f0, 0.7);
backLight.position.set(-20, -20, -20);
scene.add(backLight);

const planeGeo = new THREE.PlaneGeometry(300, 300);
const planeMat = new THREE.MeshStandardMaterial({
    color: 0xf8fafc,
    roughness: 1.0,
    metalness: 0.0
});
const basePlane = new THREE.Mesh(planeGeo, planeMat);
basePlane.receiveShadow = true;
basePlane.position.z = -1;
basePlane.visible = showGrid;
scene.add(basePlane);

const outlineMaterial = new THREE.LineBasicMaterial({ color: 0x334155, opacity: 0.15, transparent: true });

const gearColors = [
    0x3b82f6,
    0x64748b,
    0x10b981,
    0xf43f5e,
    0x8b5cf6,
    0x0ea5e9,
    0xf59e0b
];

class Gear {
    constructor(data = {}) {
        this.id = data.id !== undefined ? data.id : nextGearId++;
        if (this.id >= nextGearId) nextGearId = this.id + 1;

        this.parent = data.parent !== undefined ? data.parent : null;

        this.teeth = data.teeth || (this.parent ? 16 : 12);
        this.diametralPitch = data.diametralPitch || (this.parent ? this.parent.diametralPitch : 2);
        this.isInternal = data.isInternal || false;
        this.connectionAngle = data.connectionAngle || 0;
        this.axleConnection = data.axleConnection || false;
        this.autoPosition = data.autoPosition !== undefined ? data.autoPosition : true;
        this.pressureAngle = data.pressureAngle || 20;

        this.manualX = data.manualX || 0;
        this.manualY = data.manualY || 0;

        this.meshGroup = new THREE.Group();
        scene.add(this.meshGroup);

        this.gearMesh = null;
        this.outlineMesh = null;
        this.isColliding = false;

        this.x = 0;
        this.y = 0;
        this.z = 0;
        this.baseRotation = 0;
        this.color = gearColors[this.id % gearColors.length];

        this.labelEl = document.createElement('div');
        this.labelEl.className = 'gear-label';

        this.labelEl.addEventListener('mousedown', () => selectGear(this.id));
        labelsContainer.appendChild(this.labelEl);

        this.buildMesh();
        this.updatePosition();
    }

    get pitchDiameter() { return this.teeth / this.diametralPitch; }
    get module() { return this.pitchDiameter / this.teeth; }

    get ratio() {
        if (!this.parent) return 1;
        return this.teeth / gears[0].teeth;
    }

    get rpm() {
        if (!this.parent) return baseRpm;
        if (this.axleConnection) return this.parent.rpm;

        const dir = (this.isInternal || this.parent.isInternal) ? 1 : -1;
        return this.parent.rpm * (this.parent.teeth / this.teeth) * dir;
    }

    destroy() {
        scene.remove(this.meshGroup);
        this.labelEl.remove();
    }

    buildMesh() {
        if (this.gearMesh) {
            this.meshGroup.remove(this.gearMesh);
            this.gearMesh.geometry.dispose();
            if (this.gearMesh.material.length) this.gearMesh.material.forEach(m => m.dispose());
            else this.gearMesh.material.dispose();
        }

        const shape = new THREE.Shape();
        const numTeeth = this.teeth;
        const pd = this.pitchDiameter;
        const m = this.module;

        const paRad = (this.pressureAngle * Math.PI) / 180;
        const paTweak = Math.tan(paRad);

        const pr = pd / 2;
        const addendum = m;
        const dedendum = 1.25 * m;

        let outerRadius = pr + addendum;
        let innerRadius = Math.max(0.1, pr - dedendum);

        const angleStep = (Math.PI * 2) / numTeeth;
        const halfThick = angleStep / 4;

        const extrudeSettings = { depth: 4.5, bevelEnabled: false };

        if (this.isInternal) {
            outerRadius = pr + 2.5 * m;
            innerRadius = pr + dedendum;
            const tipRadius = pr - addendum;

            shape.absarc(0, 0, outerRadius, 0, Math.PI * 2, false);
            const holePath = new THREE.Path();

            for (let i = 0; i < numTeeth; i++) {
                const angle = -i * angleStep;

                const topW = Math.max(0, halfThick * (1 - paTweak * 0.5));
                const botW = halfThick * (1 + paTweak * 0.5);

                const a1 = angle - botW;
                const a2 = angle - topW;
                const a3 = angle + topW;
                const a4 = angle + botW;

                if (i === 0) holePath.moveTo(Math.cos(a1) * innerRadius, Math.sin(a1) * innerRadius);
                else holePath.lineTo(Math.cos(a1) * innerRadius, Math.sin(a1) * innerRadius);

                holePath.lineTo(Math.cos(a2) * tipRadius, Math.sin(a2) * tipRadius);
                holePath.lineTo(Math.cos(a3) * tipRadius, Math.sin(a3) * tipRadius);
                holePath.lineTo(Math.cos(a4) * innerRadius, Math.sin(a4) * innerRadius);
            }
            holePath.closePath();
            shape.holes.push(holePath);

        } else {
            for (let i = 0; i < numTeeth; i++) {
                const angle = i * angleStep;

                const topW = Math.max(0, halfThick * (1 - paTweak * 0.5));
                const botW = halfThick * (1 + paTweak * 0.5);

                const a1 = angle - botW;
                const a2 = angle - topW;
                const a3 = angle + topW;
                const a4 = angle + botW;

                if (i === 0) shape.moveTo(Math.cos(a1) * innerRadius, Math.sin(a1) * innerRadius);
                else shape.lineTo(Math.cos(a1) * innerRadius, Math.sin(a1) * innerRadius);

                shape.lineTo(Math.cos(a2) * outerRadius, Math.sin(a2) * outerRadius);
                shape.lineTo(Math.cos(a3) * outerRadius, Math.sin(a3) * outerRadius);
                shape.lineTo(Math.cos(a4) * innerRadius, Math.sin(a4) * innerRadius);
            }

            const holePath = new THREE.Path();
            holePath.absarc(0, 0, Math.max(0.3, innerRadius * 0.2), 0, Math.PI * 2, false);
            shape.holes.push(holePath);
        }

        const geometry = new THREE.ExtrudeGeometry(shape, extrudeSettings);
        geometry.translate(0, 0, -2.25);

        const gearMat = new THREE.MeshStandardMaterial({
            color: this.color,
            roughness: 0.5,
            metalness: 0.1,
            flatShading: true,
            polygonOffset: true,
            polygonOffsetFactor: 1,
            polygonOffsetUnits: 1
        });

        this.gearMesh = new THREE.Mesh(geometry, gearMat);
        this.gearMesh.castShadow = true;
        this.gearMesh.receiveShadow = true;
        this.gearMesh.userData.gearId = this.id;

        const edges = new THREE.EdgesGeometry(geometry);
        const edgeMat = new THREE.LineBasicMaterial({ color: 0x334155, opacity: 0.15, transparent: true });
        this.outlineMesh = new THREE.LineSegments(edges, edgeMat);
        this.gearMesh.add(this.outlineMesh);

        if (!this.isInternal) {
            const pinGeo = new THREE.CylinderGeometry(Math.max(0.15, innerRadius * 0.15), Math.max(0.15, innerRadius * 0.15), 4.7, 16);
            pinGeo.rotateX(Math.PI / 2);
            const pinMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, metalness: 0.8, roughness: 0.2 });
            const pin = new THREE.Mesh(pinGeo, pinMat);
            pin.castShadow = true;
            this.gearMesh.add(pin);
        }

        this.meshGroup.add(this.gearMesh);

        if (this.parent && this.autoPosition && !this.axleConnection) {
            const connRad = (this.connectionAngle * Math.PI) / 180;
            const ratio = this.parent.teeth / this.teeth;

            if (this.isInternal || this.parent.isInternal) {
                this.baseRotation = connRad + (this.parent.baseRotation - connRad) * ratio;
            } else {
                this.baseRotation = connRad + Math.PI + (Math.PI / this.teeth) - (this.parent.baseRotation - connRad) * ratio;
            }
        }

        this.updateLabelContent();
    }

    updatePosition() {
        if (!this.parent || !this.autoPosition) {
            this.x = this.manualX;
            this.y = this.manualY;
            this.z = this.parent ? this.parent.z : 0;
        } else if (this.axleConnection) {
            this.x = this.parent.x;
            this.y = this.parent.y;
            this.z = this.parent.z + 4.6;
        } else {
            const angleRad = (this.connectionAngle * Math.PI) / 180;
            let distance;

            if (this.isInternal) distance = (this.pitchDiameter - this.parent.pitchDiameter) / 2;
            else if (this.parent.isInternal) distance = (this.parent.pitchDiameter - this.pitchDiameter) / 2;
            else distance = (this.parent.pitchDiameter + this.pitchDiameter) / 2;

            this.x = this.parent.x + distance * Math.cos(angleRad);
            this.y = this.parent.y + distance * Math.sin(angleRad);
            this.z = this.parent.z;
        }

        this.meshGroup.position.set(this.x, this.y, this.z + (this.id * 0.001));

        if (this.parent && this.autoPosition) {
            this.manualX = this.x;
            this.manualY = this.y;
        }
    }

    updateRotation(elapsedMinutes) {
        if (!this.gearMesh || isFrozen || isEditMode) return;

        const totalRotations = this.rpm * elapsedMinutes;
        const currentAngle = (totalRotations * Math.PI * 2) % (Math.PI * 2);

        this.gearMesh.rotation.z = currentAngle + this.baseRotation;
    }

    updateLabelContent() {
        const ratioStr = this.ratio === 1 ? '1:1' : `1:${this.ratio.toFixed(2)}`;
        this.labelEl.innerHTML = `Gear <b>#${this.id}</b> <br> N=${this.teeth} | RPM: ${Math.abs(this.rpm).toFixed(1)}`;
        this.labelEl.style.display = showLabels ? 'block' : 'none';
    }

    updateLabelPosition() {
        if (!showLabels) return;

        const vector = new THREE.Vector3(this.x, this.y, this.z + 2.5);
        vector.project(camera);

        const x = (vector.x * .5 + .5) * container.clientWidth;
        const y = (vector.y * -.5 + .5) * container.clientHeight;

        this.labelEl.style.left = `${x}px`;
        this.labelEl.style.top = `${y}px`;

        if (this.id === selectedGearId) {
            this.labelEl.style.borderColor = '#3b82f6';
            this.labelEl.style.backgroundColor = '#ffffff';
            this.labelEl.style.color = '#1e40af';
            this.labelEl.style.zIndex = 10;
            this.labelEl.style.transform = 'translate(-50%, -50%) scale(1.1)';
        } else {
            this.labelEl.style.borderColor = '#cbd5e1';
            this.labelEl.style.backgroundColor = 'rgba(255, 255, 255, 0.85)';
            this.labelEl.style.color = '#475569';
            this.labelEl.style.zIndex = 1;
            this.labelEl.style.transform = 'translate(-50%, -50%) scale(1)';
        }
    }
}

function initSystem() {
    labelsContainer.innerHTML = '';

    const savedStateStr = localStorage.getItem('gearState');
    if (savedStateStr) {
        try {
            const savedState = JSON.parse(savedStateStr);
            baseRpm = savedState.baseRpm;

            gears = savedState.gears.map(data => {
                return new Gear({ ...data, parent: null });
            });

            gears.forEach(g => {
                const savedData = savedState.gears.find(sd => sd.id === g.id);
                if (savedData && savedData.parentId !== null) {
                    g.parent = gears.find(parent => parent.id === savedData.parentId);
                }
            });

            if (gears.length > 0) {
                nextGearId = Math.max(...gears.map(g => g.id)) + 1;
                selectGear(gears[0].id);
                calculateKinematics();
                return;
            }
        } catch (e) {
            console.error(e);
        }
    }

    gears = [];
    nextGearId = 0;
    const g0 = new Gear({ teeth: 24, diametralPitch: 2, autoPosition: false, manualX: 0, manualY: 0 });
    gears.push(g0);

    const g1 = new Gear({ parent: g0, teeth: 16, connectionAngle: 45 });
    gears.push(g1);

    selectGear(g1.id);
    calculateKinematics();
}

function saveState() {
    const state = {
        baseRpm: baseRpm,
        gears: gears.map(g => ({
            id: g.id,
            parentId: g.parent ? g.parent.id : null,
            teeth: g.teeth,
            diametralPitch: g.diametralPitch,
            isInternal: g.isInternal,
            connectionAngle: g.connectionAngle,
            axleConnection: g.axleConnection,
            autoPosition: g.autoPosition,
            pressureAngle: g.pressureAngle,
            manualX: g.manualX,
            manualY: g.manualY
        }))
    };
    localStorage.setItem('gearState', JSON.stringify(state));
}

function updateGearVisuals() {
    gears.forEach(g => {
        if (!g.gearMesh) return;

        if (g.isColliding) {
            g.gearMesh.material.color.setHex(0xef4444);
            g.gearMesh.material.emissive.setHex(0x550000);
            if (g.outlineMesh) {
                g.outlineMesh.material.color.setHex(0xffaaaa);
                g.outlineMesh.material.opacity = 0.8;
            }
        } else if (g.id === selectedGearId) {
            g.gearMesh.material.color.setHex(g.color);
            g.gearMesh.material.emissive.setHex(0x1e3a8a);
            if (g.outlineMesh) {
                g.outlineMesh.material.color.setHex(0x3b82f6);
                g.outlineMesh.material.opacity = 1.0;
            }
        } else {
            g.gearMesh.material.color.setHex(g.color);
            g.gearMesh.material.emissive.setHex(0x000000);
            if (g.outlineMesh) {
                g.outlineMesh.material.color.setHex(0x334155);
                g.outlineMesh.material.opacity = 0.15;
            }
        }
    });
}

function checkCollisions() {
    let hasAnyCollision = false;

    gears.forEach(g => { g.isColliding = false; });

    for (let i = 0; i < gears.length; i++) {
        for (let j = i + 1; j < gears.length; j++) {
            const g1 = gears[i];
            const g2 = gears[j];

            if (Math.abs(g1.z - g2.z) > 0.5) continue;

            const isPerfectMesh = (g1.parent === g2 && g1.autoPosition) || (g2.parent === g1 && g2.autoPosition);
            if (isPerfectMesh) continue;

            if (g1.x === g2.x && g1.y === g2.y) continue;

            const dist = Math.hypot(g1.x - g2.x, g1.y - g2.y);
            const r1 = g1.pitchDiameter / 2;
            const r2 = g2.pitchDiameter / 2;
            const maxModule = Math.max(g1.module, g2.module);

            if (!g1.isInternal && !g2.isInternal) {
                if (dist < (r1 + r2) - (maxModule * 0.5)) {
                    g1.isColliding = true;
                    g2.isColliding = true;
                    hasAnyCollision = true;
                }
            } else {
                const intG = g1.isInternal ? g1 : g2;
                const extG = g1.isInternal ? g2 : g1;
                const rInt = intG.pitchDiameter / 2;
                const rExt = extG.pitchDiameter / 2;

                if (dist + rExt > rInt - (maxModule * 0.5)) {
                    g1.isColliding = true;
                    g2.isColliding = true;
                    hasAnyCollision = true;
                }
            }
        }
    }

    updateGearVisuals();

    const warningBox = document.getElementById('collision-warning');
    if (hasAnyCollision) {
        warningBox.style.display = 'flex';
    } else {
        warningBox.style.display = 'none';
    }
}

function updatePhysicsInfo() {
    const panel = document.getElementById('physics-info-panel');
    if (!panel) return;

    const selected = gears.find(g => g.id === selectedGearId);

    if (!selected || !selected.parent || selected.axleConnection) {
        panel.style.display = 'none';
        return;
    }

    const parent = selected.parent;

    const d1 = parent.pitchDiameter;
    const d2 = selected.pitchDiameter;
    let centerDistance = 0;
    if (selected.isInternal || parent.isInternal) {
        centerDistance = Math.abs(d1 - d2) / 2;
    } else {
        centerDistance = (d1 + d2) / 2;
    }

    const rpm1 = Math.abs(parent.rpm);
    const rpm2 = Math.abs(selected.rpm);
    const rotationDir = (selected.isInternal || parent.isInternal) ? "Same" : "Opposite";

    const n1 = parent.teeth;
    const n2 = selected.teeth;
    const alignmentStep = lcm(n1, n2);
    const rot1 = alignmentStep / n1;
    const rot2 = alignmentStep / n2;

    panel.innerHTML = `
        <div class="text-xs font-bold border-b border-slate-700 pb-2 mb-3 uppercase tracking-widest text-blue-400">Kinematics & Alignment</div>
        
        <div class="mb-3">
            <div class="text-[10px] text-slate-400 uppercase tracking-wider mb-1">1. Center Distance</div>
            <div class="flex justify-between text-sm">
                <span>Distance (C):</span>
                <span class="font-mono text-blue-300">${centerDistance.toFixed(3)} units</span>
            </div>
        </div>

        <div class="mb-3">
            <div class="text-[10px] text-slate-400 uppercase tracking-wider mb-1">2. RPM Relation</div>
            <div class="flex justify-between text-sm">
                <span>Input RPM:</span>
                <span class="font-mono">${rpm1.toFixed(2)}</span>
            </div>
            <div class="flex justify-between text-sm">
                <span>Output RPM:</span>
                <span class="font-mono text-emerald-400">${rpm2.toFixed(2)}</span>
            </div>
            <div class="flex justify-between text-sm">
                <span>Rotation:</span>
                <span class="font-mono ${rotationDir === 'Same' ? 'text-amber-400' : 'text-rose-400'}">${rotationDir}</span>
            </div>
        </div>

        <div>
            <div class="text-[10px] text-slate-400 uppercase tracking-wider mb-1">3. Alignment (Kuṭṭaka)</div>
            <div class="flex justify-between text-sm">
                <span>Alignment Step:</span>
                <span class="font-mono text-purple-400">${alignmentStep} teeth</span>
            </div>
            <div class="flex justify-between text-sm">
                <span>Parent Rots:</span>
                <span class="font-mono">${rot1}</span>
            </div>
            <div class="flex justify-between text-sm">
                <span>Selected Rots:</span>
                <span class="font-mono">${rot2}</span>
            </div>
        </div>
    `;
    panel.style.display = 'block';
}

function calculateKinematics() {
    const updateChildren = (parentId) => {
        gears.filter(g => g.parent && g.parent.id === parentId).forEach(child => {
            if (!child.axleConnection) {
                child.diametralPitch = child.parent.diametralPitch;
            }
            child.buildMesh();
            child.updatePosition();
            updateChildren(child.id);
        });
    };

    const roots = gears.filter(g => !g.parent);
    if (roots.length === 0 && gears.length > 0) roots.push(gears[0]);

    roots.forEach(root => {
        root.buildMesh();
        root.updatePosition();
        updateChildren(root.id);
    });

    gears.forEach(g => g.updateLabelContent());
    checkCollisions();
    updatePhysicsInfo();
    saveState();
}

const domList = document.getElementById('gear-list');
const panelConn = document.getElementById('panel-connection');
const panelProp = document.getElementById('panel-properties');

function updateUI() {
    domList.innerHTML = '';
    gears.forEach(g => {
        const ratioStr = g.ratio === 1 ? '1:1' : `1:${g.ratio.toFixed(1)}`;
        const item = document.createElement('div');
        item.className = `gear-list-item ${g.id === selectedGearId ? 'selected' : ''}`;
        item.onclick = () => selectGear(g.id);
        item.innerHTML = `Gear #${g.id} <span class="float-right text-xs ${g.id === selectedGearId ? 'opacity-90 text-blue-200' : 'opacity-70'}">N=${g.teeth} | P=${g.diametralPitch} ${g.isInternal ? '| INT' : ''}</span>`;
        domList.appendChild(item);
    });

    const selectParent = document.getElementById('input-parent');
    selectParent.innerHTML = '';

    const noneOpt = document.createElement('option');
    noneOpt.value = "none";
    noneOpt.text = "None";
    selectParent.appendChild(noneOpt);

    gears.forEach(g => {
        let isCircular = false;
        let curr = g;
        while (curr) {
            if (curr.id === selectedGearId) { isCircular = true; break; }
            curr = curr.parent;
        }

        if (!isCircular && g.id !== selectedGearId) {
            const opt = document.createElement('option');
            opt.value = g.id;
            opt.text = `Gear #${g.id}`;
            selectParent.appendChild(opt);
        }
    });

    const selected = gears.find(g => g.id === selectedGearId);
    if (selected) {
        panelProp.classList.remove('opacity-50', 'pointer-events-none');

        document.getElementById('input-internal').checked = selected.isInternal;
        document.getElementById('input-teeth').value = selected.teeth;
        document.getElementById('input-pitch-dia').value = selected.pitchDiameter.toFixed(2);
        document.getElementById('input-pitch').value = selected.diametralPitch;
        document.getElementById('input-pa').value = selected.pressureAngle;

        panelConn.classList.remove('opacity-50', 'pointer-events-none');
        document.getElementById('input-parent').value = selected.parent ? selected.parent.id : "none";
        document.getElementById('input-axle').checked = selected.axleConnection;
        document.getElementById('input-angle').value = selected.connectionAngle;
        document.getElementById('input-auto-pos').checked = selected.autoPosition;

        const manualWrapper = document.getElementById('manual-pos-wrapper');
        const px = document.getElementById('input-pos-x');
        const py = document.getElementById('input-pos-y');

        px.value = selected.x.toFixed(2);
        py.value = selected.y.toFixed(2);

        if (selected.parent) {
            document.getElementById('input-axle').disabled = false;
            document.getElementById('input-auto-pos').disabled = false;
            document.getElementById('input-axle').closest('.property-row').classList.remove('opacity-50');
            document.getElementById('input-auto-pos').closest('.property-row').classList.remove('opacity-50');

            if (selected.autoPosition) {
                manualWrapper.classList.add('opacity-50');
                px.disabled = true; py.disabled = true;
            } else {
                manualWrapper.classList.remove('opacity-50');
                px.disabled = false; py.disabled = false;
            }

            if (selected.axleConnection) {
                document.getElementById('input-angle').disabled = true;
                document.getElementById('input-angle').closest('.property-row').classList.add('opacity-50');
            } else {
                document.getElementById('input-angle').disabled = false;
                document.getElementById('input-angle').closest('.property-row').classList.remove('opacity-50');
            }

            if (!selected.axleConnection) {
                document.getElementById('input-pitch').disabled = true;
            } else {
                document.getElementById('input-pitch').disabled = false;
            }
        } else {
            document.getElementById('input-axle').checked = false;
            document.getElementById('input-auto-pos').checked = false;

            document.getElementById('input-axle').disabled = true;
            document.getElementById('input-auto-pos').disabled = true;
            document.getElementById('input-angle').disabled = true;

            document.getElementById('input-axle').closest('.property-row').classList.add('opacity-50');
            document.getElementById('input-auto-pos').closest('.property-row').classList.add('opacity-50');
            document.getElementById('input-angle').closest('.property-row').classList.add('opacity-50');

            manualWrapper.classList.remove('opacity-50');
            px.disabled = false; py.disabled = false;

            document.getElementById('input-pitch').disabled = false;
        }

    } else {
        panelConn.classList.add('opacity-50', 'pointer-events-none');
        panelProp.classList.add('opacity-50', 'pointer-events-none');
    }

    document.getElementById('input-base-rpm').value = baseRpm;
    updatePhysicsInfo();
}

function selectGear(id) {
    selectedGearId = id;
    updateUI();
    updateGearVisuals();
    gears.forEach(g => g.updateLabelPosition());
}

window.stepValue = function (id, amount) {
    const input = document.getElementById(id);
    if (input && !input.disabled) {
        input.value = parseFloat(input.value) + amount;
        input.dispatchEvent(new Event('change'));
    }
};

window.stepZoom = function (amount) {
    camera.position.z = Math.max(10, camera.position.z - (amount * 5));
};

window.mockDownload = function (type) {
    const exporter = new THREE.OBJExporter();
    const exportGroup = new THREE.Group();
    gears.forEach(g => {
        if (g.gearMesh) {
            const clone = g.gearMesh.clone();
            clone.position.copy(g.meshGroup.position);
            exportGroup.add(clone);
        }
    });
    const result = exporter.parse(exportGroup);
    const blob = new Blob([result], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `astro_gears_system.obj`;
    a.click();
    URL.revokeObjectURL(url);
};

document.getElementById('edit-mode-toggle')?.addEventListener('change', (e) => {
    isEditMode = e.target.checked;
    controls.enabled = !isEditMode;

    if (isEditMode) {
        container.style.cursor = 'crosshair';
    } else {
        container.style.cursor = 'move';
    }
});

container.addEventListener('pointerdown', (event) => {
    if (!isEditMode) return;

    const rect = container.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return;

    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);
    const gearMeshes = gears.map(g => g.gearMesh).filter(m => m);
    const intersects = raycaster.intersectObjects(gearMeshes);

    if (intersects.length > 0) {
        const hitMesh = intersects[0].object;
        draggedGear = gears.find(g => g.gearMesh === hitMesh);

        if (draggedGear) {
            isDragging = true;
            controls.enabled = false;
            selectGear(draggedGear.id);
            container.style.cursor = 'grabbing';

            gears.filter(g => g.parent === draggedGear && g.autoPosition).forEach(child => {
                child.autoPosition = false;
                child.manualX = child.x;
                child.manualY = child.y;
            });

            draggedGear.autoPosition = false;
            draggedGear.axleConnection = false;

            dragPlane.setFromNormalAndCoplanarPoint(
                new THREE.Vector3(0, 0, 1),
                new THREE.Vector3(0, 0, draggedGear.z)
            );

            raycaster.ray.intersectPlane(dragPlane, planeIntersect);
            dragOffset.copy(planeIntersect).sub(draggedGear.meshGroup.position);
            updateUI();
        }
    }
});

window.addEventListener('pointermove', (event) => {
    if (!isEditMode) {
        container.style.cursor = 'move';
        return;
    }

    const rect = container.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    if (isDragging && draggedGear) {
        raycaster.setFromCamera(mouse, camera);
        if (raycaster.ray.intersectPlane(dragPlane, planeIntersect)) {
            const newPos = planeIntersect.clone().sub(dragOffset);
            draggedGear.manualX = newPos.x;
            draggedGear.manualY = newPos.y;

            calculateKinematics();

            const px = document.getElementById('input-pos-x');
            const py = document.getElementById('input-pos-y');
            if (px && py) {
                px.value = draggedGear.manualX.toFixed(2);
                py.value = draggedGear.manualY.toFixed(2);
            }
        }
    } else {
        if (event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) {
            raycaster.setFromCamera(mouse, camera);
            const gearMeshes = gears.map(g => g.gearMesh).filter(m => m);
            const intersects = raycaster.intersectObjects(gearMeshes);
            if (intersects.length > 0) {
                container.style.cursor = 'grab';
            } else {
                container.style.cursor = 'crosshair';
            }
        }
    }
});

window.addEventListener('pointerup', () => {
    if (isDragging && draggedGear) {
        isDragging = false;
        draggedGear = null;
        saveState();
        if (isEditMode) {
            container.style.cursor = 'crosshair';
        }
    }
});

document.getElementById('btn-toggle')?.addEventListener('click', (e) => {
    isPlaying = !isPlaying;
    e.target.classList.toggle('active', isPlaying);
    if (!isPlaying) e.target.classList.remove('active');
});

document.getElementById('btn-freeze')?.addEventListener('click', (e) => {
    isFrozen = !isFrozen;
    e.target.classList.toggle('active', isFrozen);
});

document.getElementById('btn-reset')?.addEventListener('click', () => {
    globalTime = 0;
    gears.forEach(g => { if (g.gearMesh) g.gearMesh.rotation.z = g.baseRotation; });
});

document.getElementById('btn-clear-all')?.addEventListener('click', () => {
    localStorage.removeItem('gearState');
    location.reload();
});

const rpmInput = document.getElementById('input-base-rpm');
rpmInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        const targetRpm = parseFloat(rpmInput.value) || 0;
        const selected = gears.find(g => g.id === selectedGearId);
        if (selected) {
            const multiplier = selected.rpm / baseRpm;
            if (multiplier !== 0) baseRpm = targetRpm / multiplier;
        }
        updateUI();
        saveState();
    } else if (e.key === 'Enter') {
        baseRpm = parseFloat(rpmInput.value) || 0;
        updateUI();
        saveState();
    }
});
rpmInput?.addEventListener('change', (e) => {
    baseRpm = parseFloat(e.target.value) || 0;
    updateUI();
    saveState();
});

document.getElementById('btn-add')?.addEventListener('click', () => {
    const parent = gears.find(g => g.id === selectedGearId) || gears[0];
    if (!parent) return;
    const siblings = gears.filter(g => g.parent === parent).length;
    const newGear = new Gear({ parent: parent, connectionAngle: siblings * 45 });
    gears.push(newGear);
    selectGear(newGear.id);
    calculateKinematics();
});

document.getElementById('btn-remove')?.addEventListener('click', () => {
    if (selectedGearId === null || gears.length <= 1) return;
    const removeRecursive = (id) => {
        gears.filter(g => g.parent && g.parent.id === id).forEach(c => removeRecursive(c.id));
        const idx = gears.findIndex(g => g.id === id);
        if (idx > -1) {
            gears[idx].destroy();
            gears.splice(idx, 1);
        }
    };
    removeRecursive(selectedGearId);
    selectedGearId = gears.length > 0 ? gears[0].id : null;
    calculateKinematics();
    updateUI();
});

document.getElementById('btn-select-parent')?.addEventListener('change', () => {
    handleBasicPropChange();
});

document.getElementById('input-teeth')?.addEventListener('change', (e) => {
    const selected = gears.find(g => g.id === selectedGearId);
    if (selected) {
        selected.teeth = Math.max(6, parseInt(e.target.value) || 6);
        calculateKinematics();
        updateUI();
    }
});

document.getElementById('input-pitch')?.addEventListener('change', (e) => {
    const selected = gears.find(g => g.id === selectedGearId);
    if (selected) {
        selected.diametralPitch = Math.max(0.1, parseFloat(e.target.value) || 1);
        calculateKinematics();
        updateUI();
    }
});

const pdInput = document.getElementById('input-pitch-dia');
pdInput?.addEventListener('change', (e) => {
    const selected = gears.find(g => g.id === selectedGearId);
    if (selected) {
        const newD = parseFloat(e.target.value) || 1;
        selected.teeth = Math.max(6, Math.round(newD * selected.diametralPitch));
        calculateKinematics();
        updateUI();
    }
});

function handleBasicPropChange() {
    const selected = gears.find(g => g.id === selectedGearId);
    if (!selected) return;

    const parentVal = document.getElementById('input-parent').value;
    if (parentVal === "none") {
        if (selected.parent !== null) {
            selected.manualX = selected.x;
            selected.manualY = selected.y;
        }
        selected.parent = null;
        selected.autoPosition = false;
        selected.axleConnection = false;
    } else {
        const parentId = parseInt(parentVal);
        selected.parent = gears.find(g => g.id === parentId) || selected.parent;
    }

    selected.axleConnection = document.getElementById('input-axle').checked;
    selected.connectionAngle = parseFloat(document.getElementById('input-angle').value) || 0;
    selected.autoPosition = document.getElementById('input-auto-pos').checked;

    if (!selected.autoPosition && !selected.axleConnection) {
        selected.manualX = parseFloat(document.getElementById('input-pos-x').value) || 0;
        selected.manualY = parseFloat(document.getElementById('input-pos-y').value) || 0;
    }

    selected.isInternal = document.getElementById('input-internal').checked;
    selected.pressureAngle = Math.max(10, Math.min(80, parseFloat(document.getElementById('input-pa').value) || 20));

    calculateKinematics();
    updateUI();
}

['input-parent', 'input-axle', 'input-angle', 'input-auto-pos', 'input-pos-x', 'input-pos-y',
    'input-internal', 'input-pa'].forEach(id => {
        document.getElementById(id)?.addEventListener('change', handleBasicPropChange);
    });

document.getElementById('toggle-grid')?.addEventListener('change', (e) => {
    showGrid = e.target.checked;
    basePlane.visible = showGrid;
});
document.getElementById('toggle-labels')?.addEventListener('change', (e) => {
    showLabels = e.target.checked;
    gears.forEach(g => g.updateLabelContent());
});

function animate() {
    requestAnimationFrame(animate);

    const currentTime = performance.now();
    const deltaTime = (currentTime - lastTime) / 1000;
    lastTime = currentTime;

    if (isPlaying && !isFrozen && !isEditMode) {
        globalTime += deltaTime / 60;
    }

    gears.forEach(g => {
        g.updateRotation(globalTime);
        g.updateLabelPosition();
    });

    controls.update();
    renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
});

initSystem();
animate();