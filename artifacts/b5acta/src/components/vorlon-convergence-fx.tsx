import { useEffect, useMemo, useRef, type MutableRefObject } from "react";
import { useFrame, useLoader } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";

const MODEL_FILENAME = "vorlon-dreadnought.glb";
const MODEL_REVISION = "20260727-heavy-cruiser-v1";
const WIND_TEXTURE_FILENAME = "T_VFX_WindNoise1.png";
const CHARGE_SECONDS = 1;
const FIRE_SECONDS = 2.35;
const ACTIVE_END_SECONDS = CHARGE_SECONDS + FIRE_SECONDS;
const SMALL_EMITTER_NAMES = [
  "small beam 1",
  "small beam 2",
  "small beam 3",
  "small beam 4",
] as const;
const COLOR = "#35ff67";
const SECONDARY_COLOR = "#d8ffe1";
const INTENSITY = 1.55;
const SMALL_RADIUS = 0.006;
const PRIMARY_RADIUS = 0.0325;

function assetUrl(kind: "models" | "textures", filename: string): string {
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  return `${basePath}/api/${kind}/${filename}`;
}

function modelUrl(): string {
  return `${assetUrl("models", MODEL_FILENAME)}?v=${encodeURIComponent(MODEL_REVISION)}`;
}

function normalizeEmitterName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[_\-.]+/g, " ")
    .replace(/\s+/g, " ");
}

function modelScaleForTargetSize(object: THREE.Object3D, targetInches: number): number {
  const box = new THREE.Box3().setFromObject(object);
  const size = new THREE.Vector3();
  box.getSize(size);
  const maxHorizontal = Math.max(size.x, size.z);
  return maxHorizontal > 0 ? targetInches / maxHorizontal : 1;
}

function phaseAlpha(elapsed: number, start: number): number {
  if (elapsed < start || elapsed >= ACTIVE_END_SECONDS) return 0;
  const fadeIn = THREE.MathUtils.smoothstep(elapsed, start, start + 0.1);
  const fadeOut =
    1 -
    THREE.MathUtils.smoothstep(
      elapsed,
      ACTIVE_END_SECONDS - 0.14,
      ACTIVE_END_SECONDS,
    );
  return fadeIn * fadeOut;
}

function seededUnit(seed: number): number {
  const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return value - Math.floor(value);
}

function TimedBeam({
  from,
  to,
  startRef,
  mode,
  radius,
  texture,
}: {
  from: THREE.Vector3;
  to: THREE.Vector3;
  startRef: MutableRefObject<number>;
  mode: "charge" | "primary";
  radius: number;
  texture?: THREE.Texture;
}) {
  const coreRef = useRef<THREE.MeshBasicMaterial>(null);
  const shellRef = useRef<THREE.MeshBasicMaterial>(null);
  const haloRef = useRef<THREE.MeshBasicMaterial>(null);
  const lightRef = useRef<THREE.PointLight>(null);
  const { midpoint, quaternion, length } = useMemo(() => {
    const direction = to.clone().sub(from);
    return {
      midpoint: from.clone().add(to).multiplyScalar(0.5),
      quaternion: new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        direction.clone().normalize(),
      ),
      length: direction.length(),
    };
  }, [from.x, from.y, from.z, to.x, to.y, to.z]);

  useFrame(() => {
    const elapsed = (performance.now() - startRef.current) * 0.001;
    const alpha = phaseAlpha(elapsed, mode === "primary" ? CHARGE_SECONDS : 0);
    const pulse =
      0.86 + Math.sin(elapsed * (mode === "primary" ? 11.5 : 17.5)) * 0.14;
    if (texture && mode === "primary") {
      texture.offset.x = (elapsed * -0.08) % 1;
      texture.offset.y = (elapsed * -0.42) % 1;
    }
    if (coreRef.current) {
      coreRef.current.opacity = THREE.MathUtils.clamp(
        alpha * INTENSITY * pulse,
        0,
        1,
      );
    }
    if (shellRef.current) {
      shellRef.current.opacity = THREE.MathUtils.clamp(
        alpha * INTENSITY * pulse * (mode === "primary" ? 0.78 : 0.42),
        0,
        0.96,
      );
    }
    if (haloRef.current) {
      haloRef.current.opacity = THREE.MathUtils.clamp(
        alpha * INTENSITY * pulse * (mode === "primary" ? 0.32 : 0.12),
        0,
        0.62,
      );
    }
    if (lightRef.current) {
      lightRef.current.intensity =
        alpha * INTENSITY * (mode === "primary" ? 4.8 : 0.75);
    }
  });

  return (
    <group position={midpoint.toArray()} quaternion={quaternion}>
      <mesh raycast={() => null} renderOrder={7}>
        <cylinderGeometry args={[radius, radius, length, 10, 1]} />
        <meshBasicMaterial
          ref={coreRef}
          color={SECONDARY_COLOR}
          transparent
          opacity={0}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      <mesh raycast={() => null} renderOrder={6}>
        <cylinderGeometry args={[radius * 2.35, radius * 2.35, length, 14, 1]} />
        <meshBasicMaterial
          ref={shellRef}
          color={COLOR}
          alphaMap={texture}
          alphaTest={texture ? 0.32 : 0}
          transparent
          opacity={0}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      <mesh raycast={() => null} renderOrder={5}>
        <cylinderGeometry args={[radius * 4.8, radius * 4.8, length, 18, 1]} />
        <meshBasicMaterial
          ref={haloRef}
          color={COLOR}
          alphaMap={texture}
          alphaTest={texture ? 0.18 : 0}
          transparent
          opacity={0}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      <pointLight
        ref={lightRef}
        color={COLOR}
        intensity={0}
        distance={mode === "primary" ? 11 : 3.5}
      />
    </group>
  );
}

function FeederParticles({
  from,
  to,
  startRef,
  phaseOffset,
}: {
  from: THREE.Vector3;
  to: THREE.Vector3;
  startRef: MutableRefObject<number>;
  phaseOffset: number;
}) {
  const particleCount = 5;
  const particlesRef = useRef<THREE.InstancedMesh>(null);
  const materialRef = useRef<THREE.MeshBasicMaterial>(null);
  const direction = useMemo(() => to.clone().sub(from), [from, to]);
  const transform = useMemo(() => new THREE.Object3D(), []);

  useFrame(() => {
    const elapsed = (performance.now() - startRef.current) * 0.001;
    const alpha = phaseAlpha(elapsed, 0);
    const particles = particlesRef.current;
    if (particles) {
      particles.visible = alpha > 0.01;
      for (let index = 0; index < particleCount; index += 1) {
        const progress = (elapsed * 1.35 + phaseOffset + index / particleCount) % 1;
        const sizePulse = 0.82 + Math.sin(elapsed * 20 + index * 1.7) * 0.18;
        transform.position.copy(from).addScaledVector(direction, progress);
        transform.scale.setScalar(sizePulse);
        transform.updateMatrix();
        particles.setMatrixAt(index, transform.matrix);
      }
      particles.instanceMatrix.needsUpdate = true;
    }
    if (materialRef.current) {
      materialRef.current.opacity = THREE.MathUtils.clamp(
        alpha * INTENSITY * 1.25,
        0,
        1,
      );
    }
  });

  return (
    <instancedMesh
      ref={particlesRef}
      args={[undefined, undefined, particleCount]}
      frustumCulled={false}
      raycast={() => null}
      renderOrder={9}
    >
      <sphereGeometry args={[0.045, 8, 6]} />
      <meshBasicMaterial
        ref={materialRef}
        color={SECONDARY_COLOR}
        transparent
        opacity={0}
        blending={THREE.AdditiveBlending}
        depthTest={false}
        depthWrite={false}
        toneMapped={false}
      />
    </instancedMesh>
  );
}

function RadialParticles({
  origin,
  startRef,
}: {
  origin: THREE.Vector3;
  startRef: MutableRefObject<number>;
}) {
  const particleCount = 48;
  const materialRef = useRef<THREE.PointsMaterial>(null);
  const flights = useMemo(
    () =>
      Array.from({ length: particleCount }, (_, index) => {
        const azimuth = seededUnit(index * 4.17 + 0.31) * Math.PI * 2;
        const vertical = seededUnit(index * 7.93 + 1.27) * 2 - 1;
        const planar = Math.sqrt(Math.max(0, 1 - vertical * vertical));
        const direction = new THREE.Vector3(
          Math.cos(azimuth) * planar,
          vertical,
          Math.sin(azimuth) * planar,
        ).normalize();
        const tangent = new THREE.Vector3(
          -direction.z,
          seededUnit(index * 9.11 + 2.41) - 0.5,
          direction.x,
        ).normalize();
        return {
          direction,
          tangent,
          phase: seededUnit(index * 3.73 + 4.19),
          lifetime: 0.42 + seededUnit(index * 5.29 + 3.07) * 0.9,
          distance: 0.28 + seededUnit(index * 6.61 + 5.13) * 0.48,
          wobble: 0.015 + seededUnit(index * 8.47 + 0.83) * 0.05,
          frequency: 5 + seededUnit(index * 10.13 + 1.91) * 9,
        };
      }),
    [],
  );
  const geometry = useMemo(() => {
    const result = new THREE.BufferGeometry();
    result.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(particleCount * 3), 3),
    );
    return result;
  }, []);

  useEffect(() => () => geometry.dispose(), [geometry]);

  useFrame(() => {
    const elapsed = (performance.now() - startRef.current) * 0.001;
    const alpha = phaseAlpha(elapsed, 0);
    const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
    for (let index = 0; index < particleCount; index += 1) {
      const flight = flights[index];
      const age = (elapsed / flight.lifetime + flight.phase) % 1;
      const distance = age * flight.distance;
      const jitter =
        Math.sin(elapsed * flight.frequency + flight.phase * Math.PI * 2) *
        flight.wobble *
        Math.sin(Math.PI * age);
      positions.setXYZ(
        index,
        origin.x + flight.direction.x * distance + flight.tangent.x * jitter,
        origin.y + flight.direction.y * distance + flight.tangent.y * jitter,
        origin.z + flight.direction.z * distance + flight.tangent.z * jitter,
      );
    }
    positions.needsUpdate = true;
    if (materialRef.current) {
      materialRef.current.opacity = THREE.MathUtils.clamp(
        alpha * INTENSITY * 0.95,
        0,
        1,
      );
    }
  });

  return (
    <points
      geometry={geometry}
      frustumCulled={false}
      raycast={() => null}
      renderOrder={10}
    >
      <pointsMaterial
        ref={materialRef}
        color={COLOR}
        size={1.1}
        sizeAttenuation={false}
        transparent
        opacity={0}
        blending={THREE.AdditiveBlending}
        depthTest={false}
        depthWrite={false}
        toneMapped={false}
      />
    </points>
  );
}

function NodeGlow({
  position,
  startRef,
  mode,
}: {
  position: THREE.Vector3;
  startRef: MutableRefObject<number>;
  mode: "source" | "target";
}) {
  const groupRef = useRef<THREE.Group>(null);
  const coreRef = useRef<THREE.MeshBasicMaterial>(null);
  const haloRef = useRef<THREE.MeshBasicMaterial>(null);
  const lightRef = useRef<THREE.PointLight>(null);

  useFrame(() => {
    const elapsed = (performance.now() - startRef.current) * 0.001;
    const alpha = phaseAlpha(elapsed, mode === "target" ? CHARGE_SECONDS : 0);
    const firingBoost =
      elapsed >= CHARGE_SECONDS && elapsed < ACTIVE_END_SECONDS ? 1.35 : 1;
    const pulse = 0.88 + Math.sin(elapsed * 14) * 0.12;
    groupRef.current?.scale.setScalar(
      pulse * firingBoost * (mode === "target" ? 1.45 : 1),
    );
    if (coreRef.current) {
      coreRef.current.opacity = THREE.MathUtils.clamp(
        alpha * INTENSITY,
        0,
        1,
      );
    }
    if (haloRef.current) {
      haloRef.current.opacity = THREE.MathUtils.clamp(
        alpha * INTENSITY * 0.24,
        0,
        0.6,
      );
    }
    if (lightRef.current) {
      lightRef.current.intensity =
        alpha * INTENSITY * (mode === "target" ? 4.2 : 3.2);
    }
  });

  const radius = PRIMARY_RADIUS * (mode === "target" ? 1.1 : 0.3);
  return (
    <group ref={groupRef} position={position.toArray()}>
      <mesh raycast={() => null} renderOrder={8}>
        <sphereGeometry args={[radius, 20, 14]} />
        <meshBasicMaterial
          ref={coreRef}
          color={SECONDARY_COLOR}
          transparent
          opacity={0}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      <mesh raycast={() => null} renderOrder={7}>
        <sphereGeometry args={[radius * 2.8, 22, 16]} />
        <meshBasicMaterial
          ref={haloRef}
          color={COLOR}
          transparent
          opacity={0}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      <pointLight
        ref={lightRef}
        color={COLOR}
        intensity={0}
        distance={mode === "target" ? 9 : 6}
      />
    </group>
  );
}

export function VorlonConvergenceFx({
  from,
  to,
  headingDegrees,
}: {
  from: THREE.Vector3;
  to: THREE.Vector3;
  headingDegrees?: number;
}) {
  const { scene } = useGLTF(modelUrl());
  const sourceTexture = useLoader(
    THREE.TextureLoader,
    assetUrl("textures", WIND_TEXTURE_FILENAME),
  );
  const beamTexture = useMemo(() => {
    const texture = sourceTexture.clone();
    texture.colorSpace = THREE.NoColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(1.8, 7);
    texture.needsUpdate = true;
    return texture;
  }, [sourceTexture]);
  useEffect(() => () => beamTexture.dispose(), [beamTexture]);
  const startRef = useRef(performance.now());
  const yaw = THREE.MathUtils.degToRad(
    headingDegrees ??
      THREE.MathUtils.radToDeg(Math.atan2(to.x - from.x, to.z - from.z)),
  );

  const { smallEmitters, mainEmitter } = useMemo(() => {
    scene.updateMatrixWorld(true);
    const scale = modelScaleForTargetSize(scene, 3);
    const inverseRoot = scene.matrixWorld.clone().invert();
    const localPositions = new Map<string, THREE.Vector3>();
    scene.traverse(child => {
      const name = normalizeEmitterName(String(child.name ?? ""));
      if (
        name === "main beam" ||
        SMALL_EMITTER_NAMES.includes(
          name as (typeof SMALL_EMITTER_NAMES)[number],
        )
      ) {
        localPositions.set(
          name,
          child
            .getWorldPosition(new THREE.Vector3())
            .applyMatrix4(inverseRoot)
            .multiplyScalar(scale),
        );
      }
    });
    const rotation = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      yaw,
    );
    const toWorld = (position: THREE.Vector3) =>
      position.clone().applyQuaternion(rotation).add(from);
    return {
      smallEmitters: SMALL_EMITTER_NAMES.map(name =>
        toWorld(localPositions.get(name) ?? new THREE.Vector3(0, 0, 1.1)),
      ),
      mainEmitter: toWorld(
        localPositions.get("main beam") ?? new THREE.Vector3(0, 0, 1.3),
      ),
    };
  }, [from.x, from.y, from.z, scene, yaw]);

  return (
    <>
      {smallEmitters.map((emitter, index) => (
        <group key={SMALL_EMITTER_NAMES[index]}>
          <TimedBeam
            from={emitter}
            to={mainEmitter}
            startRef={startRef}
            mode="charge"
            radius={SMALL_RADIUS}
          />
          <FeederParticles
            from={emitter}
            to={mainEmitter}
            startRef={startRef}
            phaseOffset={index * 0.17}
          />
        </group>
      ))}
      <TimedBeam
        from={mainEmitter}
        to={to}
        startRef={startRef}
        mode="primary"
        radius={PRIMARY_RADIUS}
        texture={beamTexture}
      />
      <NodeGlow position={mainEmitter} startRef={startRef} mode="source" />
      <RadialParticles origin={mainEmitter} startRef={startRef} />
      <NodeGlow position={to} startRef={startRef} mode="target" />
    </>
  );
}
