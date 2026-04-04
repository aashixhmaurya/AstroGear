let gears = [];
let nextGearId = 0;
let selectedGearId = null;

let isPlaying = true;
let isFrozen = false;
let globalCollision = false;

let baseRpm = 10;
let baseDirection = 1;
let rootRotations = 0;
let lastTime = performance.now();

let isEditMode = false;
let isDragging = false;
let draggedGear = null;

let raycaster = new THREE.Raycaster();
let mouse = new THREE.Vector2();
let dragPlane = new THREE.Plane();
let planeIntersect = new THREE.Vector3();
let dragOffset = new THREE.Vector3();

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
container.appendChild(renderer.domElement);

const controls = new THREE.OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.screenSpacePanning = true;
controls.maxPolarAngle = Math.PI / 2 + 0.1;

const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
scene.add(ambientLight);

const dirLight = new THREE.DirectionalLight(0xffffff, 0.6);
dirLight.position.set(30, 40, 50);
scene.add(dirLight);

const backLight = new THREE.DirectionalLight(0xe2e8f0, 0.7);
backLight.position.set(-20, -20, -20);
scene.add(backLight);

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

        this.updatePosition();
        this.buildMesh();
    }

    get pitchDiameter() {
        return this.teeth / this.diametralPitch;
    }

    get module() {
        return this.pitchDiameter / this.teeth;
    }

    get ratioToRoot() {
        if (!this.parent) {
            return (gears.length > 0 && this.id === gears[0].id) || gears.length === 0 ? 1 : 0;
        }

        let isConnected = false;
        if (this.autoPosition) {
            isConnected = true;
        } else if (this.axleConnection) {
            if (Math.abs(this.x - this.parent.x) < 0.1 && Math.abs(this.y - this.parent.y) < 0.1) {
                isConnected = true;
            }
        } else {
            const dist = Math.hypot(this.x - this.parent.x, this.y - this.parent.y);
            let idealDist = this.isInternal ?
                Math.abs(this.pitchDiameter - this.parent.pitchDiameter) / 2 :
                this.parent.isInternal ?
                    Math.abs(this.parent.pitchDiameter - this.pitchDiameter) / 2 :
                    (this.pitchDiameter + this.parent.pitchDiameter) / 2;

            const tolerance = Math.max(this.module, this.parent.module) * 0.8;
            if (Math.abs(dist - idealDist) <= tolerance && Math.abs(this.z - this.parent.z) < 0.5) {
                isConnected = true;
            }
        }

        if (!isConnected) return 0;
        if (this.axleConnection) return this.parent.ratioToRoot;

        const dir = (this.isInternal || this.parent.isInternal) ? 1 : -1;
        return this.parent.ratioToRoot * (this.parent.teeth / this.teeth) * dir;
    }

    get rpm() {
        return globalCollision ? 0 : baseRpm * baseDirection * this.ratioToRoot;
    }

    get currentAngle() {
        return (rootRotations * this.ratioToRoot * Math.PI * 2 + (this.baseRotation || 0)) % (Math.PI * 2);
    }

    destroy() {
        scene.remove(this.meshGroup);
        this.labelEl.remove();
    }

    buildMesh() {
        if (this.gearMesh) {
            this.meshGroup.remove(this.gearMesh);
            this.gearMesh.geometry.dispose();
        }

        const shape = new THREE.Shape();
        const numTeeth = this.teeth;
        const pr = this.pitchDiameter / 2;
        const m = this.module;
        const paRad = (this.pressureAngle * Math.PI) / 180;
        const paTweak = Math.tan(paRad);
        const angleStep = (Math.PI * 2) / numTeeth;
        const halfThick = angleStep / 4;

        if (this.isInternal) {
            let outer = pr + 2.5 * m;
            let inner = pr + 1.25 * m;
            let tip = pr - m;

            shape.absarc(0, 0, outer, 0, Math.PI * 2, false);
            const hole = new THREE.Path();

            for (let i = 0; i < numTeeth; i++) {
                const a = -i * angleStep;
                const tW = Math.max(0, halfThick * (1 - paTweak * 0.5));
                const bW = halfThick * (1 + paTweak * 0.5);

                if (i === 0) hole.moveTo(Math.cos(a - bW) * inner, Math.sin(a - bW) * inner);
                else hole.lineTo(Math.cos(a - bW) * inner, Math.sin(a - bW) * inner);

                hole.lineTo(Math.cos(a - tW) * tip, Math.sin(a - tW) * tip);
                hole.lineTo(Math.cos(a + tW) * tip, Math.sin(a + tW) * tip);
                hole.lineTo(Math.cos(a + bW) * inner, Math.sin(a + bW) * inner);
            }
            hole.closePath();
            shape.holes.push(hole);
        } else {
            let out = pr + m;
            let inn = Math.max(0.1, pr - 1.25 * m);

            for (let i = 0; i < numTeeth; i++) {
                const a = i * angleStep;
                const tW = Math.max(0, halfThick * (1 - paTweak * 0.5));
                const bW = halfThick * (1 + paTweak * 0.5);

                if (i === 0) shape.moveTo(Math.cos(a - bW) * inn, Math.sin(a - bW) * inn);
                else shape.lineTo(Math.cos(a - bW) * inn, Math.sin(a - bW) * inn);

                shape.lineTo(Math.cos(a - tW) * out, Math.sin(a - tW) * out);
                shape.lineTo(Math.cos(a + tW) * out, Math.sin(a + tW) * out);
                shape.lineTo(Math.cos(a + bW) * inn, Math.sin(a + bW) * inn);
            }

            const hole = new THREE.Path();
            hole.absarc(0, 0, Math.max(0.3, (pr - 1.25 * m) * 0.2), 0, Math.PI * 2, false);
            shape.holes.push(hole);
        }

        const geometry = new THREE.ExtrudeGeometry(shape, { depth: 4.5, bevelEnabled: false });
        geometry.translate(0, 0, -2.25);

        this.gearMesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
            color: this.color,
            roughness: 0.5,
            metalness: 0.1,
            flatShading: true,
            polygonOffset: true,
            polygonOffsetFactor: 1,
            polygonOffsetUnits: 1
        }));

        this.gearMesh.userData.gearId = this.id;
        this.gearMesh.add(new THREE.LineSegments(
            new THREE.EdgesGeometry(geometry),
            new THREE.LineBasicMaterial({ color: 0x334155, opacity: 0.15, transparent: true })
        ));

        if (!this.isInternal) {
            const pin = new THREE.Mesh(
                new THREE.CylinderGeometry(Math.max(0.15, pr * 0.1), Math.max(0.15, pr * 0.1), 4.7, 16),
                new THREE.MeshStandardMaterial({ color: 0x94a3b8, metalness: 0.8, roughness: 0.2 })
            );
            pin.rotateX(Math.PI / 2);
            this.gearMesh.add(pin);
        }

        this.meshGroup.add(this.gearMesh);
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
            const a = (this.connectionAngle * Math.PI) / 180;
            let d = this.isInternal ?
                (this.pitchDiameter - this.parent.pitchDiameter) / 2 :
                this.parent.isInternal ?
                    (this.parent.pitchDiameter - this.pitchDiameter) / 2 :
                    (this.parent.pitchDiameter + this.pitchDiameter) / 2;

            this.x = this.parent.x + d * Math.cos(a);
            this.y = this.parent.y + d * Math.sin(a);
            this.z = this.parent.z;
        }
        this.meshGroup.position.set(this.x, this.y, this.z + (this.id * 0.001));
        if (this.parent && this.autoPosition) {
            this.manualX = this.x;
            this.manualY = this.y;
        }
    }

    updateRotation() {
        if (this.gearMesh) this.gearMesh.rotation.z = this.currentAngle;
    }

    updateLabelContent() {
        let rpm = Math.abs(this.rpm);
        if (isNaN(rpm) || globalCollision) rpm = 0;

        this.labelEl.innerHTML = `Gear <b>#${this.id}</b> <br> N=${this.teeth} | RPM: ${rpm.toFixed(1)}`;
        this.labelEl.style.display = showLabels ? 'block' : 'none';

        if (this.id === selectedGearId) {
            const tel = document.getElementById('tel-rpm');
            if (tel) tel.innerText = `${rpm.toFixed(1)} RPM`;
        }
    }

    updateLabelPosition() {
        if (!showLabels) return;
        const v = new THREE.Vector3(this.x, this.y, this.z + 2.5);
        v.project(camera);

        const px = (v.x * .5 + .5) * container.clientWidth;
        const py = (v.y * -.5 + .5) * container.clientHeight;

        this.labelEl.style.left = `${px}px`;
        this.labelEl.style.top = `${py}px`;

        if (this.id === selectedGearId) {
            this.labelEl.style.borderColor = '#3b82f6';
            this.labelEl.style.backgroundColor = '#ffffff';
            this.labelEl.style.zIndex = 10;
            this.labelEl.style.transform = 'translate(-50%, -50%) scale(1.15)';
        } else {
            this.labelEl.style.borderColor = '#cbd5e1';
            this.labelEl.style.backgroundColor = 'rgba(255, 255, 255, 0.9)';
            this.labelEl.style.zIndex = 1;
            this.labelEl.style.transform = 'translate(-50%, -50%) scale(1)';
        }
    }
}

function initSystem() {
    labelsContainer.innerHTML = '';
    const saved = localStorage.getItem('astroGearStateV2');
    if (saved) {
        try {
            const state = JSON.parse(saved);
            baseRpm = state.baseRpm;
            baseDirection = state.baseDirection || 1;

            gears = state.gears.map(d => new Gear({ ...d, parent: null }));
            gears.forEach(g => {
                const d = state.gears.find(s => s.id === g.id);
                if (d && d.parentId !== null) {
                    g.parent = gears.find(p => p.id === d.parentId);
                }
            });

            if (gears.length > 0) {
                gears.forEach((g, i) => {
                    g.id = i;
                    g.color = gearColors[g.id % gearColors.length];
                    if (g.gearMesh) g.gearMesh.material.color.setHex(g.color);
                });
                nextGearId = gears.length;
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
    const g1 = new Gear({ parent: g0, teeth: 16, connectionAngle: 0 });
    gears.push(g1);

    selectGear(g1.id);
    calculateKinematics();
}

function saveState() {
    localStorage.setItem('astroGearStateV2', JSON.stringify({
        baseRpm,
        baseDirection,
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
    }));
}

function updateGearVisuals() {
    gears.forEach(g => {
        if (!g.gearMesh) return;
        if (g.isColliding) {
            g.gearMesh.material.color.setHex(0xef4444);
            g.gearMesh.material.emissive.setHex(0x550000);
        } else if (g.id === selectedGearId) {
            g.gearMesh.material.color.setHex(g.color);
            g.gearMesh.material.emissive.setHex(0x1e3a8a);
        } else {
            g.gearMesh.material.color.setHex(g.color);
            g.gearMesh.material.emissive.setHex(0x000000);
        }
    });
}

function checkCollisions() {
    globalCollision = false;
    let paError = false;
    let overlapError = false;
    gears.forEach(g => g.isColliding = false);

    for (let i = 0; i < gears.length; i++) {
        for (let j = i + 1; j < gears.length; j++) {
            const g1 = gears[i];
            const g2 = gears[j];
            if (Math.abs(g1.z - g2.z) > 0.5) continue;

            const dist = Math.hypot(g1.x - g2.x, g1.y - g2.y);
            const isPC = (g1.parent === g2 || g2.parent === g1);

            if (g1.x === g2.x && g1.y === g2.y) {
                if (!isPC && Math.abs(g1.rpm - g2.rpm) > 0.1) {
                    g1.isColliding = g2.isColliding = globalCollision = overlapError = true;
                }
                continue;
            }

            const r1 = g1.pitchDiameter / 2;
            const r2 = g2.pitchDiameter / 2;
            const m1 = g1.module;
            const m2 = g2.module;
            const paDiff = Math.abs(g1.pressureAngle - g2.pressureAngle);

            if (!g1.isInternal && !g2.isInternal) {
                const idD = r1 + r2;
                const outD = idD + m1 + m2;
                if (dist <= outD + 0.1 && paDiff > 10) {
                    g1.isColliding = g2.isColliding = globalCollision = paError = true;
                }
                if (isPC) {
                    if (dist < idD - Math.max(m1, m2) * 0.2) g1.isColliding = g2.isColliding = globalCollision = overlapError = true;
                } else {
                    if (dist < outD - 0.05) g1.isColliding = g2.isColliding = globalCollision = overlapError = true;
                }
            } else {
                const intG = g1.isInternal ? g1 : g2;
                const extG = g1.isInternal ? g2 : g1;
                const rInt = intG.pitchDiameter / 2;
                const idD = rInt - (extG.pitchDiameter / 2);
                if (dist <= rInt && paDiff > 10) {
                    g1.isColliding = g2.isColliding = globalCollision = paError = true;
                }
                if (isPC) {
                    if (dist > idD + Math.max(intG.module, extG.module) * 0.2) g1.isColliding = g2.isColliding = globalCollision = overlapError = true;
                } else {
                    if (dist + (extG.pitchDiameter / 2) + extG.module > rInt - intG.module + 0.05 && dist < rInt + (extG.pitchDiameter / 2)) {
                        g1.isColliding = g2.isColliding = globalCollision = overlapError = true;
                    }
                }
            }
        }
    }
    updateGearVisuals();
    const warningBox = document.getElementById('collision-warning');
    const warningText = document.getElementById('warning-text');
    if (globalCollision) {
        if (paError && overlapError) warningText.innerText = "System Jammed! Gears are overlapping AND have incompatible Pressure Angles.";
        else if (paError) warningText.innerText = "Incompatible Pressure Angles! Meshing gears must have a PA difference of 10° or less.";
        else warningText.innerText = "Gears are physically overlapping or conflicting in a mesh loop. Please adjust the layout.";
        warningBox.style.display = 'flex';
    } else {
        warningBox.style.display = 'none';
    }
}

function calculateKinematics() {
    const upd = (pId) => {
        gears.filter(g => g.parent && g.parent.id === pId).forEach(c => {
            if (!c.axleConnection) c.diametralPitch = c.parent.diametralPitch;
            c.updatePosition();
            c.buildMesh();
            if (c.axleConnection) {
                c.baseRotation = c.parent.baseRotation || 0;
            } else {
                let aR = (c.connectionAngle * Math.PI) / 180;
                if (!c.autoPosition) aR = Math.atan2(c.y - c.parent.y, c.x - c.parent.x) || 0;
                const r = c.parent.teeth / c.teeth;
                if (c.isInternal || c.parent.isInternal) c.baseRotation = aR + ((c.parent.baseRotation || 0) - aR) * r;
                else c.baseRotation = aR + Math.PI + (Math.PI / c.teeth) - ((c.parent.baseRotation || 0) - aR) * r;
            }
            upd(c.id);
        });
    };
    const roots = gears.filter(g => !g.parent);
    if (roots.length === 0 && gears.length > 0) roots.push(gears[0]);
    roots.forEach(r => { r.updatePosition(); r.buildMesh(); upd(r.id); });
    gears.forEach(g => g.updateLabelContent());
    checkCollisions();
    saveState();
}

const domList = document.getElementById('gear-list');
const panelConn = document.getElementById('panel-connection');
const panelProp = document.getElementById('panel-properties');

function updateUI() {
    domList.innerHTML = '';
    gears.forEach(g => {
        const item = document.createElement('div');
        item.className = `gear-list-item ${g.id === selectedGearId ? 'selected' : ''}`;
        item.onclick = () => selectGear(g.id);
        item.innerHTML = `<span>Gear #${g.id}</span> <span class="text-xs opacity-90">N=${g.teeth} | P=${g.diametralPitch} ${g.isInternal ? '| INT' : ''}</span>`;
        domList.appendChild(item);
    });

    const selP = document.getElementById('input-parent');
    selP.innerHTML = '';
    const none = document.createElement('option');
    none.value = "none";
    none.text = "None";
    selP.appendChild(none);

    gears.forEach(g => {
        let isC = false;
        let curr = g;
        while (curr) {
            if (curr.id === selectedGearId) { isC = true; break; }
            curr = curr.parent;
        }
        if (!isC && g.id !== selectedGearId) {
            const o = document.createElement('option');
            o.value = g.id;
            o.text = `Gear #${g.id}`;
            selP.appendChild(o);
        }
    });

    const sel = gears.find(g => g.id === selectedGearId);
    if (sel) {
        panelProp.classList.remove('opacity-50', 'pointer-events-none');
        document.getElementById('input-teeth').value = sel.teeth;
        document.getElementById('input-pitch-dia').value = sel.pitchDiameter.toFixed(2);
        document.getElementById('input-pitch').value = sel.diametralPitch;
        document.getElementById('input-pa').value = sel.pressureAngle;

        panelConn.classList.remove('opacity-50', 'pointer-events-none');
        document.getElementById('input-parent').value = sel.parent ? sel.parent.id : "none";
        document.getElementById('input-axle').checked = sel.axleConnection;
        document.getElementById('input-angle').value = sel.connectionAngle;
        document.getElementById('input-auto-pos').checked = sel.autoPosition;

        const pX = document.getElementById('input-pos-x');
        const pY = document.getElementById('input-pos-y');
        pX.value = sel.x.toFixed(2);
        pY.value = sel.y.toFixed(2);

        if (sel.parent) {
            document.getElementById('input-axle').disabled = document.getElementById('input-auto-pos').disabled = false;
            document.getElementById('input-axle').closest('.property-row').classList.remove('opacity-70');
            document.getElementById('input-auto-pos').closest('.property-row').classList.remove('opacity-70');
            if (sel.autoPosition) {
                document.getElementById('manual-pos-wrapper').classList.add('opacity-70');
                pX.disabled = pY.disabled = true;
            } else {
                document.getElementById('manual-pos-wrapper').classList.remove('opacity-70');
                pX.disabled = pY.disabled = false;
            }
            if (sel.axleConnection) {
                document.getElementById('input-angle').disabled = true;
                document.getElementById('input-angle').closest('.property-row').classList.add('opacity-70');
            } else {
                document.getElementById('input-angle').disabled = false;
                document.getElementById('input-angle').closest('.property-row').classList.remove('opacity-70');
            }
            document.getElementById('input-pitch').disabled = !sel.axleConnection;
        } else {
            document.getElementById('input-axle').checked = document.getElementById('input-auto-pos').checked = false;
            document.getElementById('input-axle').disabled = document.getElementById('input-auto-pos').disabled = document.getElementById('input-angle').disabled = true;
            document.getElementById('input-axle').closest('.property-row').classList.add('opacity-70');
            document.getElementById('input-auto-pos').closest('.property-row').classList.add('opacity-70');
            document.getElementById('input-angle').closest('.property-row').classList.add('opacity-70');
            document.getElementById('manual-pos-wrapper').classList.remove('opacity-70');
            pX.disabled = pY.disabled = false;
            document.getElementById('input-pitch').disabled = false;
        }
        document.getElementById('input-parent').disabled = (gears.length > 0 && sel.id === gears[0].id);
        if (document.getElementById('input-parent').disabled) document.getElementById('input-parent').closest('.property-row').classList.add('opacity-70');
        else document.getElementById('input-parent').closest('.property-row').classList.remove('opacity-70');

        const tP = document.getElementById('telemetry-panel');
        if (tP) {
            tP.classList.remove('hidden');
            tP.classList.add('flex');
            let rpm = Math.abs(sel.rpm);
            if (isNaN(rpm) || globalCollision) rpm = 0;
            let rS = sel.ratioToRoot !== 0 ? "1 : " + (1 / Math.abs(sel.ratioToRoot)).toFixed(2) : (gears.length > 0 && sel.id !== gears[0].id ? "DISCONNECTED" : "1 : 1.00");
            const dir = sel.ratioToRoot === 0 ? '-' : (sel.ratioToRoot * baseDirection >= 0 ? "CW" : "CCW");
            document.getElementById('telemetry-content').innerHTML = `
                <div class="flex justify-between border-b border-white/15 py-0.5"><span class="text-white/60 text-[0.85rem]">Gear ID</span><span class="font-medium">#${sel.id}</span></div>
                <div class="flex justify-between border-b border-white/15 py-0.5"><span class="text-white/60 text-[0.85rem]">Speed (RPM)</span><span class="font-medium" id="tel-rpm">${rpm.toFixed(1)}</span></div>
                <div class="flex justify-between border-b border-white/15 py-0.5"><span class="text-white/60 text-[0.85rem]">Direction</span><span class="font-medium">${dir}</span></div>
                <div class="flex justify-between border-b border-white/15 py-0.5"><span class="text-white/60 text-[0.85rem]">Ratio (Mtr)</span><span class="font-medium">${rS}</span></div>
                <div class="flex justify-between pt-0.5"><span class="text-white/60 text-[0.85rem]">Pitch Dia</span><span class="font-medium">${sel.pitchDiameter.toFixed(2)}</span></div>`;
        }
    } else {
        panelConn.classList.add('opacity-70', 'pointer-events-none');
        panelProp.classList.add('opacity-70', 'pointer-events-none');
        const tP = document.getElementById('telemetry-panel');
        if (tP) { tP.classList.add('hidden'); tP.classList.remove('flex'); }
    }
    document.getElementById('input-base-rpm').value = baseRpm;
    document.getElementById('input-base-direction').value = baseDirection;
}

function selectGear(id) {
    selectedGearId = id;
    updateUI();
    updateGearVisuals();
    gears.forEach(g => g.updateLabelPosition());
}

window.stepValue = function (id, amt) {
    const i = document.getElementById(id);
    if (i && !i.disabled) {
        i.value = parseFloat(i.value) + amt;
        i.dispatchEvent(new Event('change'));
    }
};

window.mockDownload = function (type) {
    const exp = new THREE.OBJExporter();
    const grp = new THREE.Group();
    gears.forEach(g => {
        if (g.gearMesh) {
            const c = g.gearMesh.clone();
            c.position.copy(g.meshGroup.position);
            grp.add(c);
        }
    });
    const res = exp.parse(grp);
    const b = new Blob([res], { type: 'text/plain' });
    const u = URL.createObjectURL(b);
    const a = document.createElement('a');
    a.href = u;
    a.download = `astro_gears_system.obj`;
    a.click();
    URL.revokeObjectURL(u);
};

const uiP = document.getElementById('ui-panel');
const res = document.getElementById('panel-resizer');
let resizing = false;

res.addEventListener('mousedown', () => {
    resizing = true;
    document.body.style.cursor = 'col-resize';
    document.body.classList.add('no-select');
    container.style.pointerEvents = 'none';
});

document.addEventListener('mousemove', (e) => {
    if (!resizing) return;
    let w = e.clientX;
    if (w < 350) w = 350;
    if (w > window.innerWidth - 300) w = window.innerWidth - 300;
    if (w > 800) w = 800;
    uiP.style.width = w + 'px';
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
});

document.addEventListener('mouseup', () => {
    if (resizing) {
        resizing = false;
        document.body.style.cursor = 'default';
        document.body.classList.remove('no-select');
        container.style.pointerEvents = 'auto';
    }
});

document.getElementById('edit-mode-toggle')?.addEventListener('change', (e) => {
    isEditMode = e.target.checked;
    controls.enabled = !isEditMode;
    container.style.cursor = isEditMode ? 'crosshair' : 'move';
});

container.addEventListener('pointerdown', (e) => {
    if (!isEditMode) return;
    const rect = container.getBoundingClientRect();
    if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) return;
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObjects(gears.map(g => g.gearMesh).filter(m => m));
    if (intersects.length > 0) {
        draggedGear = gears.find(g => g.gearMesh === intersects[0].object);
        if (draggedGear) {
            isDragging = true;
            controls.enabled = false;
            selectGear(draggedGear.id);
            container.style.cursor = 'grabbing';
            gears.filter(g => g.parent === draggedGear).forEach(c => {
                c.baseRotation = c.currentAngle;
                c.parent = null;
                c.autoPosition = false;
                c.manualX = c.x;
                c.manualY = c.y;
            });
            if (gears.length > 0 && draggedGear.id !== gears[0].id) {
                draggedGear.baseRotation = draggedGear.currentAngle;
                draggedGear.parent = draggedGear.autoPosition = draggedGear.axleConnection = false;
            }
            dragPlane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, draggedGear.z));
            raycaster.ray.intersectPlane(dragPlane, planeIntersect);
            dragOffset.copy(planeIntersect).sub(draggedGear.meshGroup.position);
            updateUI();
        }
    }
});

window.addEventListener('pointermove', (e) => {
    if (!isEditMode) { container.style.cursor = 'move'; return; }
    const rect = container.getBoundingClientRect();
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    if (isDragging && draggedGear) {
        raycaster.setFromCamera(mouse, camera);
        if (raycaster.ray.intersectPlane(dragPlane, planeIntersect)) {
            const nP = planeIntersect.clone().sub(dragOffset);
            draggedGear.manualX = nP.x;
            draggedGear.manualY = nP.y;
            calculateKinematics();
            const pX = document.getElementById('input-pos-x');
            const pY = document.getElementById('input-pos-y');
            if (pX && pY) { pX.value = draggedGear.manualX.toFixed(2); pY.value = draggedGear.manualY.toFixed(2); }
        }
    } else if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
        raycaster.setFromCamera(mouse, camera);
        container.style.cursor = raycaster.intersectObjects(gears.map(g => g.gearMesh).filter(m => m)).length > 0 ? 'grab' : 'crosshair';
    }
});

window.addEventListener('pointerup', () => {
    if (isDragging && draggedGear) {
        if (gears.length > 0 && draggedGear.id !== gears[0].id) {
            let snp = false;
            for (let o of gears) {
                if (o === draggedGear) continue;
                let c = o;
                let circ = false;
                while (c) { if (c === draggedGear) { circ = true; break; } c = c.parent; }
                if (circ) continue;
                let iD = draggedGear.isInternal ? (draggedGear.pitchDiameter - o.pitchDiameter) / 2 : o.isInternal ? (o.pitchDiameter - draggedGear.pitchDiameter) / 2 : (draggedGear.pitchDiameter + o.pitchDiameter) / 2;
                const d = Math.hypot(draggedGear.manualX - o.x, draggedGear.manualY - o.y);
                const t = Math.max(draggedGear.module, o.module) * 1.5;
                if (Math.abs(d - iD) < t) {
                    draggedGear.parent = o; draggedGear.autoPosition = true; draggedGear.axleConnection = false;
                    let aR = Math.atan2(draggedGear.manualY - o.y, draggedGear.manualX - o.x);
                    let aD = (aR * 180 / Math.PI); if (aD < 0) aD += 360;
                    draggedGear.connectionAngle = parseFloat(aD.toFixed(2)); snp = true; break;
                }
                if (d < t * 0.5) {
                    draggedGear.parent = o; draggedGear.autoPosition = true; draggedGear.axleConnection = true; draggedGear.connectionAngle = 0; snp = true; break;
                }
            }
            if (!snp) { draggedGear.parent = null; draggedGear.autoPosition = false; }
        }
        let orphansChanged = true;
        while (orphansChanged) {
            orphansChanged = false;
            for (let orphan of gears) {
                if (gears.length > 0 && orphan.id !== gears[0].id && orphan.parent === null) {
                    for (let pP of gears) {
                        if (pP === orphan) continue;
                        let curr = pP; let isC = false;
                        while (curr) { if (curr.id === gears[0].id) { isC = true; break; } curr = curr.parent; }
                        if (!isC) continue;
                        let iD = orphan.isInternal ? Math.abs(orphan.pitchDiameter - pP.pitchDiameter) / 2 : pP.isInternal ? Math.abs(pP.pitchDiameter - orphan.pitchDiameter) / 2 : (orphan.pitchDiameter + pP.pitchDiameter) / 2;
                        const dist = Math.hypot(orphan.manualX - pP.x, orphan.manualY - pP.y);
                        const tol = Math.max(orphan.module, pP.module) * 1.5;
                        if (Math.abs(dist - iD) < tol) {
                            orphan.parent = pP; orphan.autoPosition = true; orphan.axleConnection = false;
                            let aR = Math.atan2(orphan.manualY - pP.y, orphan.manualX - pP.x);
                            let aD = (aR * 180 / Math.PI); if (aD < 0) aD += 360;
                            orphan.connectionAngle = parseFloat(aD.toFixed(2)); orphansChanged = true; break;
                        }
                        if (dist < tol * 0.5) { orphan.parent = pP; orphan.autoPosition = true; orphan.axleConnection = true; orphan.connectionAngle = 0; orphansChanged = true; break; }
                    }
                }
            }
        }
        isDragging = false; draggedGear = null; calculateKinematics(); updateUI(); saveState();
        if (isEditMode) container.style.cursor = 'crosshair';
    }
});

document.getElementById('btn-toggle')?.addEventListener('click', (e) => {
    isPlaying = !isPlaying;
    e.target.classList.toggle('active', isPlaying);
});

document.getElementById('btn-freeze')?.addEventListener('click', (e) => {
    isFrozen = !isFrozen;
    e.target.classList.toggle('active', isFrozen);
});

document.getElementById('btn-reset')?.addEventListener('click', () => {
    rootRotations = 0;
    gears.forEach(g => { if (!g.parent) g.baseRotation = 0; });
    calculateKinematics();
});

document.getElementById('btn-clear-all')?.addEventListener('click', () => {
    localStorage.removeItem('astroGearStateV2');
    location.reload();
});

document.getElementById('input-base-rpm')?.addEventListener('change', (e) => {
    baseRpm = parseFloat(e.target.value) || 0;
    updateUI(); saveState();
});

document.getElementById('input-base-direction')?.addEventListener('change', (e) => {
    baseDirection = parseInt(e.target.value);
    updateUI(); saveState();
});

document.getElementById('btn-add')?.addEventListener('click', () => {
    const parent = gears.find(g => g.id === selectedGearId) || (gears.length > 0 ? gears[0] : null);
    if (!parent) return;
    const dp = parent.diametralPitch;
    const nPd = 16 / dp;
    let bA = parent.connectionAngle || 0;
    let bstA = bA; let fnd = false;
    for (let o = 0; o <= 180; o += 15) {
        const tA = o === 0 ? [bA] : [bA + o, bA - o];
        for (let t of tA) {
            let a = (t % 360 + 360) % 360;
            const r = a * Math.PI / 180;
            const dist = (parent.pitchDiameter + nPd) / 2;
            const tX = parent.x + dist * Math.cos(r);
            const tY = parent.y + dist * Math.sin(r);
            let hC = false;
            for (const g of gears) {
                if (g === parent) continue;
                if (Math.abs(parent.z - g.z) > 0.5) continue;
                if (Math.hypot(tX - g.x, tY - g.y) < (nPd / 2 + g.pitchDiameter / 2 + 1 / dp + g.module + 0.1)) { hC = true; break; }
            }
            if (!hC) { bstA = a; fnd = true; break; }
        }
        if (fnd) break;
    }
    if (!fnd) bstA = 0;
    const nG = new Gear({ parent: parent, connectionAngle: parseFloat(bstA.toFixed(2)) });
    gears.push(nG); gears.forEach((g, i) => { g.id = i; if (g.gearMesh) g.gearMesh.userData.gearId = g.id; });
    nextGearId = gears.length; selectGear(nG.id); calculateKinematics();
});

document.getElementById('btn-remove')?.addEventListener('click', () => {
    if (selectedGearId === null || gears.length <= 1 || (gears.length > 0 && selectedGearId === gears[0].id)) return;
    const gR = gears.find(g => g.id === selectedGearId);
    if (gR) {
        gears.filter(g => g.parent === gR).forEach(c => { c.parent = null; c.autoPosition = false; c.manualX = c.x; c.manualY = c.y; c.baseRotation = c.currentAngle; });
        gR.destroy(); gears = gears.filter(g => g.id !== selectedGearId);
        gears.forEach((g, i) => {
            g.id = i; g.color = gearColors[g.id % gearColors.length];
            if (g.gearMesh) { g.gearMesh.material.color.setHex(g.color); g.gearMesh.userData.gearId = g.id; }
        });
        nextGearId = gears.length; selectedGearId = gears.length > 0 ? gears[gears.length - 1].id : null;
        calculateKinematics(); updateUI();
    }
});

document.getElementById('input-teeth')?.addEventListener('change', (e) => {
    const s = gears.find(g => g.id === selectedGearId);
    if (s) { s.teeth = Math.max(6, parseInt(e.target.value) || 6); calculateKinematics(); updateUI(); }
});

document.getElementById('input-pitch')?.addEventListener('change', (e) => {
    const s = gears.find(g => g.id === selectedGearId);
    if (s) { s.diametralPitch = Math.max(0.1, parseFloat(e.target.value) || 1); calculateKinematics(); updateUI(); }
});

['input-parent', 'input-axle', 'input-angle', 'input-auto-pos', 'input-pos-x', 'input-pos-y', 'input-pa'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', handleBasicPropChange);
});

document.getElementById('toggle-labels')?.addEventListener('change', (e) => {
    showLabels = e.target.checked;
    gears.forEach(g => g.updateLabelContent());
});

function handleBasicPropChange() {
    const s = gears.find(g => g.id === selectedGearId); if (!s) return;
    const pV = document.getElementById('input-parent').value;
    if (pV === "none") {
        if (s.parent !== null) { s.baseRotation = s.currentAngle; s.manualX = s.x; s.manualY = s.y; }
        s.parent = null; s.autoPosition = s.axleConnection = false;
    } else s.parent = gears.find(g => g.id === parseInt(pV)) || s.parent;
    s.axleConnection = document.getElementById('input-axle').checked;
    s.connectionAngle = parseFloat(document.getElementById('input-angle').value) || 0;
    s.autoPosition = document.getElementById('input-auto-pos').checked;
    if (!s.autoPosition && !s.axleConnection) {
        s.manualX = parseFloat(document.getElementById('input-pos-x').value) || 0;
        s.manualY = parseFloat(document.getElementById('input-pos-y').value) || 0;
    }
    s.pressureAngle = Math.max(10, Math.min(60, parseFloat(document.getElementById('input-pa').value) || 20));
    calculateKinematics(); updateUI();
}

function animate() {
    requestAnimationFrame(animate);
    const now = performance.now();
    const dt = (now - lastTime) / 1000;
    lastTime = now;
    if (isPlaying && !isFrozen && !isEditMode && !globalCollision) rootRotations += (baseRpm * baseDirection / 60) * dt;
    gears.forEach(g => { g.updateRotation(); g.updateLabelContent(); g.updateLabelPosition(); });
    controls.update(); renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
});

initSystem();
animate();