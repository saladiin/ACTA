import { useState, useRef, Suspense } from "react";
import { useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { Canvas, useLoader } from "@react-three/fiber";
import { OrbitControls, Text, useGLTF } from "@react-three/drei";
// @ts-ignore
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
// @ts-ignore
import * as THREE from "three";
import {
  useGetGame,
  useAcceptGame,
  useDeclineGame,
  useDeployFleet,
  useSubmitTurn,
  useListFleets,
  useListFleetShips,
  getGetGameQueryKey,
  getListTurnsQueryKey,
  getListFleetShipsQueryKey,
} from "@workspace/api-client-react";
import { useUser } from "@clerk/react";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Swords, Shield, Target, CheckCircle, XCircle, Crosshair, Move, Zap } from "lucide-react";

function hexToWorld(q: number, r: number): [number, number, number] {
  return [q * 2.25, 0, r * 2.6 + q * 1.3];
}

function SpaceGrid() {
  return (
    <>
      {/* Fine 1-unit grid */}
      <gridHelper args={[80, 80, "#0f1f0f", "#0a160a"]} position={[0, -0.01, 0]} />
      {/* Bold 5-unit grid overlay */}
      <gridHelper args={[80, 16, "#1a2e1a", "#1a2e1a"]} position={[0, -0.005, 0]} />
    </>
  );
}

function ObjModel({ url, color }: { url: string; color: string }) {
  const obj = useLoader(OBJLoader, url) as THREE.Group;
  const cloned = obj.clone();
  cloned.traverse((child: any) => {
    if (child.isMesh) {
      child.material = new THREE.MeshStandardMaterial({ color });
    }
  });
  return <primitive object={cloned} scale={[0.4, 0.4, 0.4]} />;
}

function GlbModel({ url, color }: { url: string; color: string }) {
  const { scene } = useGLTF(url);
  const cloned = scene.clone();
  cloned.traverse((child: any) => {
    if (child.isMesh) {
      child.material = new THREE.MeshStandardMaterial({
        color,
        metalness: 0.4,
        roughness: 0.5,
      });
    }
  });
  return <primitive object={cloned} scale={[0.4, 0.4, 0.4]} />;
}

function ShipModelFallback({ color }: { color: string }) {
  return (
    <mesh>
      <boxGeometry args={[0.6, 0.2, 1.2]} />
      <meshStandardMaterial color={color} />
    </mesh>
  );
}

function ShipModel3D({ filename, color }: { filename: string; color: string }) {
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const url = `${basePath}/api/models/${filename}`;
  const isGlb = filename.toLowerCase().endsWith(".glb") || filename.toLowerCase().endsWith(".gltf");
  if (isGlb) {
    return <GlbModel url={url} color={color} />;
  }
  return <ObjModel url={url} color={color} />;
}

function GameUnit3D({ unit, isSelected, onClick, myUserId }: {
  unit: { id: number; hexQ: number; hexR: number; name: string; modelFilename: string; ownerId: string; hullPoints: number; maxHullPoints: number; isDestroyed: boolean; faction: string };
  isSelected: boolean;
  onClick: () => void;
  myUserId: string;
}) {
  const [x, y, z] = hexToWorld(unit.hexQ, unit.hexR);
  const isMine = unit.ownerId === myUserId;
  const color = unit.isDestroyed ? "#4b5563" : isMine ? "#f59e0b" : "#ef4444";
  const hpPct = unit.hullPoints / unit.maxHullPoints;

  return (
    <group position={[x, y + 0.15, z]} onClick={onClick}>
      <Suspense fallback={<ShipModelFallback color={color} />}>
        <ShipModel3D filename={unit.modelFilename} color={color} />
      </Suspense>
      {isSelected && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.1, 0]}>
          <ringGeometry args={[0.9, 1.1, 6]} />
          <meshStandardMaterial color="#f59e0b" emissive="#f59e0b" emissiveIntensity={0.5} transparent opacity={0.8} />
        </mesh>
      )}
      {/* HP bar */}
      <group position={[0, 0.8, 0]}>
        <mesh position={[0, 0, 0]}>
          <planeGeometry args={[1.2, 0.12]} />
          <meshBasicMaterial color="#1f2937" transparent opacity={0.9} />
        </mesh>
        <mesh position={[-0.6 * (1 - hpPct), 0, 0.001]} scale={[hpPct, 1, 1]}>
          <planeGeometry args={[1.2, 0.1]} />
          <meshBasicMaterial color={hpPct > 0.5 ? "#22c55e" : hpPct > 0.25 ? "#f59e0b" : "#ef4444"} />
        </mesh>
      </group>
      <Text position={[0, 1.2, 0]} fontSize={0.3} color="white" anchorX="center" anchorY="middle" outlineWidth={0.03} outlineColor="black">
        {unit.name.slice(0, 12)}
      </Text>
    </group>
  );
}

function HexGrid({ size = 6 }: { size?: number }) {
  const tiles = [];
  for (let q = -size; q <= size; q++) {
    for (let r = -size; r <= size; r++) {
      if (Math.abs(q + r) <= size) {
        tiles.push({ q, r });
      }
    }
  }
  return (
    <>
      {tiles.map(({ q, r }) => (
        <HexTile key={`${q},${r}`} q={q} r={r} />
      ))}
    </>
  );
}

export default function GameBoard() {
  const params = useParams<{ id: string }>();
  const gameId = parseInt(params.id ?? "0");
  const { user } = useUser();
  const myUserId = user?.id ?? "";
  const qc = useQueryClient();

  const { data: gameData, isLoading } = useGetGame(gameId, { query: { queryKey: getGetGameQueryKey(gameId) } });
  const { data: fleets } = useListFleets();
  const acceptGame = useAcceptGame();
  const declineGame = useDeclineGame();
  const deployFleet = useDeployFleet();
  const submitTurn = useSubmitTurn();

  const [selectedUnit, setSelectedUnit] = useState<number | null>(null);
  const [moveTarget, setMoveTarget] = useState<{ q: number; r: number } | null>(null);
  const [attackTarget, setAttackTarget] = useState<number | null>(null);
  const [turnMoves, setTurnMoves] = useState<Array<{ unitId: number; toHexQ: number; toHexR: number; newHeading: number }>>([]);
  const [turnAttacks, setTurnAttacks] = useState<Array<{ attackerUnitId: number; targetUnitId: number }>>([]);
  const [deployFleetId, setDeployFleetId] = useState<string>("");
  const [deployPlacements, setDeployPlacements] = useState<Array<{ shipId: number; hexQ: number; hexR: number; heading: number }>>([]);
  const [deployShipIdx, setDeployShipIdx] = useState(0);

  const { data: deployShips } = useListFleetShips(parseInt(deployFleetId ?? "0"), {
    query: { queryKey: getListFleetShipsQueryKey(parseInt(deployFleetId ?? "0")), enabled: !!deployFleetId }
  });

  const game = gameData?.game;
  const units = gameData?.units ?? [];
  const turns = gameData?.turns ?? [];

  const isChallenger = game?.challengerId === myUserId;
  const isOpponent = game?.opponentId === myUserId;
  const isMyTurn = game?.status === "active" && (
    (isChallenger && (game.currentTurn % 2 === 1)) ||
    (isOpponent && (game.currentTurn % 2 === 0))
  );

  const selectedUnitData = units.find(u => u.id === selectedUnit);

  const handleUnitClick = (unitId: number) => {
    const unit = units.find(u => u.id === unitId);
    if (!unit || unit.isDestroyed) return;

    if (selectedUnit && selectedUnit !== unitId && unit.ownerId !== myUserId) {
      // Attack
      const attacker = units.find(u => u.id === selectedUnit);
      if (attacker && attacker.ownerId === myUserId) {
        setTurnAttacks(prev => [...prev.filter(a => a.attackerUnitId !== selectedUnit), { attackerUnitId: selectedUnit, targetUnitId: unitId }]);
        setAttackTarget(unitId);
      }
      return;
    }

    if (unit.ownerId === myUserId) {
      setSelectedUnit(unitId === selectedUnit ? null : unitId);
      setMoveTarget(null);
      setAttackTarget(null);
    }
  };

  const handleSubmitTurn = () => {
    submitTurn.mutate(
      { gameId, data: { moves: turnMoves, attacks: turnAttacks } },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) });
          qc.invalidateQueries({ queryKey: getListTurnsQueryKey(gameId) });
          setTurnMoves([]);
          setTurnAttacks([]);
          setSelectedUnit(null);
        }
      }
    );
  };

  const handleDeploy = () => {
    if (!deployFleetId || deployPlacements.length === 0) return;
    deployFleet.mutate(
      { gameId, data: { fleetId: parseInt(deployFleetId), placements: deployPlacements } },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) });
          setDeployPlacements([]);
        }
      }
    );
  };

  if (isLoading) {
    return (
      <Layout title="Loading...">
        <div className="p-6 space-y-4">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-[400px] w-full" />
        </div>
      </Layout>
    );
  }

  if (!game) {
    return <Layout title="Not Found"><div className="p-6 text-muted-foreground">Game not found.</div></Layout>;
  }

  return (
    <Layout title={`${game.challengerName ?? "?"} vs ${game.opponentName ?? "?"}`}>
      <div className="flex flex-col lg:flex-row h-full min-h-[calc(100dvh-4rem)]">
        {/* 3D Board */}
        <div className="flex-1 relative min-h-[400px] lg:min-h-0 bg-black">
          <Canvas camera={{ position: [0, 12, 12], fov: 50 }} shadows>
            <ambientLight intensity={0.4} />
            <directionalLight position={[10, 20, 10]} intensity={1} castShadow />
            <pointLight position={[0, 10, 0]} intensity={0.5} color="#f59e0b" />
            <fog attach="fog" args={["#050505", 20, 50]} />
            <SpaceGrid />
            {units.map(unit => (
              <GameUnit3D
                key={unit.id}
                unit={unit}
                isSelected={selectedUnit === unit.id}
                onClick={() => handleUnitClick(unit.id)}
                myUserId={myUserId}
              />
            ))}
            <OrbitControls enablePan={true} enableZoom={true} enableRotate={true} minDistance={5} maxDistance={35} />
            <gridHelper args={[30, 30, "#1f2937", "#111827"]} position={[0, -0.1, 0]} />
          </Canvas>
          {/* Status overlay */}
          <div className="absolute top-3 left-3 flex flex-col gap-1.5 pointer-events-none">
            <div className={`px-2 py-1 rounded text-xs font-mono tracking-widest uppercase border ${
              game.status === "active" ? "bg-green-500/10 border-green-500/30 text-green-400" :
              game.status === "pending" ? "bg-amber-500/10 border-amber-500/30 text-amber-400" :
              game.status === "deploying" ? "bg-blue-500/10 border-blue-500/30 text-blue-400" :
              "bg-muted/10 border-muted/30 text-muted-foreground"
            }`}>
              {game.status} {game.status === "active" && `— Turn ${game.currentTurn}`}
            </div>
            {isMyTurn && (
              <div className="px-2 py-1 rounded text-xs font-mono tracking-widest uppercase border border-primary/40 bg-primary/10 text-primary animate-pulse">
                Your Turn
              </div>
            )}
            {game.winnerId && (
              <div className="px-2 py-1 rounded text-xs font-mono tracking-widest uppercase border border-yellow-500/40 bg-yellow-500/10 text-yellow-400">
                {game.winnerId === myUserId ? "Victory" : "Defeated"}
              </div>
            )}
          </div>
          {/* Camera hint */}
          <div className="absolute bottom-3 left-3 text-xs text-gray-500 font-mono pointer-events-none">
            Drag to rotate &bull; Scroll to zoom &bull; Right-drag to pan
          </div>
        </div>

        {/* Sidebar panel */}
        <div className="w-full lg:w-72 border-t lg:border-t-0 lg:border-l border-border bg-card flex flex-col">

          {/* Pending challenge actions */}
          {game.status === "pending" && isOpponent && (
            <div className="p-4 border-b border-border space-y-2">
              <p className="text-xs text-muted-foreground font-mono uppercase tracking-wider">Challenge from {game.challengerName}</p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  data-testid="button-accept-game"
                  className="flex-1 gap-1.5 uppercase tracking-wider text-xs"
                  onClick={() => acceptGame.mutate({ gameId }, { onSuccess: () => qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) }) })}
                  disabled={acceptGame.isPending}
                >
                  <CheckCircle className="w-3.5 h-3.5" /> Accept
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  data-testid="button-decline-game"
                  className="flex-1 gap-1.5 uppercase tracking-wider text-xs"
                  onClick={() => declineGame.mutate({ gameId }, { onSuccess: () => qc.invalidateQueries({ queryKey: getGetGameQueryKey(gameId) }) })}
                  disabled={declineGame.isPending}
                >
                  <XCircle className="w-3.5 h-3.5" /> Decline
                </Button>
              </div>
            </div>
          )}

          {/* Deploying phase */}
          {game.status === "deploying" && (
            <div className="p-4 border-b border-border space-y-3">
              <p className="text-xs text-primary font-mono uppercase tracking-wider">Deploy Your Fleet</p>
              <Select value={deployFleetId} onValueChange={val => { setDeployFleetId(val); setDeployPlacements([]); setDeployShipIdx(0); }}>
                <SelectTrigger data-testid="select-deploy-fleet" className="bg-background text-xs">
                  <SelectValue placeholder="Select fleet..." />
                </SelectTrigger>
                <SelectContent className="bg-card border-border">
                  {fleets?.map(f => (
                    <SelectItem key={f.id} value={String(f.id)}>{f.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {deployShips && deployShips.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    Placing: <span className="text-foreground font-medium">{deployShips[deployShipIdx]?.name}</span>
                    {" "}({deployShipIdx + 1}/{deployShips.length})
                  </p>
                  <div className="grid grid-cols-2 gap-1.5">
                    {[-3, -2, -1, 0, 1, 2, 3].map(q =>
                      [-3, -2, -1, 0].map(r => {
                        const placed = deployPlacements.find(p => p.hexQ === q && p.hexR === r);
                        return (
                          <button
                            key={`${q},${r}`}
                            onClick={() => {
                              if (deployShipIdx >= deployShips.length) return;
                              const ship = deployShips[deployShipIdx];
                              if (placed) return;
                              setDeployPlacements(prev => [...prev, { shipId: ship.id, hexQ: q, hexR: r, heading: 0 }]);
                              setDeployShipIdx(prev => prev + 1);
                            }}
                            className={`text-[9px] font-mono py-1 rounded border ${placed ? "border-primary/50 bg-primary/10 text-primary" : "border-border bg-background hover:border-primary/30 text-muted-foreground"}`}
                          >
                            {q},{r}
                          </button>
                        );
                      })
                    )}
                  </div>
                  {deployPlacements.length > 0 && (
                    <Button size="sm" className="w-full uppercase tracking-wider text-xs" onClick={handleDeploy} disabled={deployFleet.isPending}>
                      {deployFleet.isPending ? "Deploying..." : `Deploy (${deployPlacements.length} ships)`}
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Selected unit info */}
          {selectedUnitData && (
            <div data-testid="selected-unit-panel" className="p-4 border-b border-border">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Selected Unit</span>
                <button className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setSelectedUnit(null)}>clear</button>
              </div>
              <div className="space-y-1">
                <p className="font-bold text-sm text-primary">{selectedUnitData.name}</p>
                <p className="text-xs text-muted-foreground font-mono">{selectedUnitData.faction}</p>
                <div className="flex gap-3 text-xs font-mono mt-1">
                  <span className="flex items-center gap-1"><Shield className="w-3 h-3 text-green-400" />{selectedUnitData.hullPoints}/{selectedUnitData.maxHullPoints}</span>
                  <span className="flex items-center gap-1"><Zap className="w-3 h-3 text-amber-400" />{selectedUnitData.weaponDamage} dmg</span>
                  <span className="flex items-center gap-1"><Crosshair className="w-3 h-3 text-blue-400" />r{selectedUnitData.weaponRange}</span>
                </div>
                <p className="text-xs text-muted-foreground">Hex: {selectedUnitData.hexQ},{selectedUnitData.hexR}</p>
              </div>
            </div>
          )}

          {/* Turn actions */}
          {game.status === "active" && isMyTurn && (
            <div className="p-4 border-b border-border space-y-3">
              <p className="text-xs font-mono text-primary uppercase tracking-wider">Turn {game.currentTurn} — Your Move</p>
              <div className="space-y-1 text-xs text-muted-foreground font-mono">
                <p className="flex items-center gap-1"><Move className="w-3 h-3" /> {turnMoves.length} moves queued</p>
                <p className="flex items-center gap-1"><Target className="w-3 h-3" /> {turnAttacks.length} attacks queued</p>
              </div>
              {selectedUnitData && selectedUnitData.ownerId === myUserId && (
                <p className="text-xs text-muted-foreground">Click an empty hex to plan a move, or click an enemy ship to attack</p>
              )}
              <Button
                size="sm"
                data-testid="button-submit-turn"
                className="w-full gap-1.5 uppercase tracking-widest text-xs font-bold"
                onClick={handleSubmitTurn}
                disabled={submitTurn.isPending || (turnMoves.length === 0 && turnAttacks.length === 0)}
              >
                <Swords className="w-3.5 h-3.5" />
                {submitTurn.isPending ? "Submitting..." : "Commit Orders"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="w-full text-xs text-muted-foreground uppercase tracking-wider"
                onClick={() => { setTurnMoves([]); setTurnAttacks([]); setSelectedUnit(null); }}
              >
                Clear Orders
              </Button>
            </div>
          )}

          {/* Move history */}
          <div className="flex-1 overflow-hidden flex flex-col">
            <div className="px-4 pt-3 pb-2 border-b border-border">
              <p className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Combat Log</p>
            </div>
            <ScrollArea className="flex-1 px-4 py-2">
              {turns.length === 0 ? (
                <p className="text-xs text-muted-foreground py-4 text-center">No turns yet</p>
              ) : (
                <div className="space-y-1.5">
                  {turns.map(turn => (
                    <div key={turn.id} data-testid={`turn-${turn.id}`} className="text-xs border border-border rounded px-2 py-1.5 bg-background/40">
                      <div className="font-mono text-muted-foreground">T{turn.turnNumber} &mdash; {turn.playerId === myUserId ? "You" : (isChallenger ? game.opponentName : game.challengerName)}</div>
                      <div className="text-foreground">
                        {Array.isArray(turn.moves) ? (turn.moves as Array<{ unitId: number }>).length : 0} moves,{" "}
                        {Array.isArray(turn.attacks) ? (turn.attacks as Array<{ attackerUnitId: number }>).length : 0} attacks
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </div>

          {/* Unit roster */}
          <div className="border-t border-border">
            <div className="px-4 pt-3 pb-2">
              <p className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Fleet Status</p>
            </div>
            <ScrollArea className="h-32 px-4 pb-3">
              <div className="space-y-1">
                {units.map(unit => (
                  <div
                    key={unit.id}
                    data-testid={`unit-${unit.id}`}
                    className={`flex items-center justify-between text-xs rounded px-2 py-1 cursor-pointer transition-colors ${unit.ownerId === myUserId ? "border border-amber-500/20 bg-amber-500/5 hover:bg-amber-500/10" : "border border-red-500/20 bg-red-500/5 hover:bg-red-500/10"} ${unit.isDestroyed ? "opacity-40 line-through" : ""}`}
                    onClick={() => handleUnitClick(unit.id)}
                  >
                    <span className="font-mono truncate max-w-[110px]">{unit.name}</span>
                    <span className="font-mono text-muted-foreground shrink-0">{unit.hullPoints}/{unit.maxHullPoints}</span>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>
        </div>
      </div>
    </Layout>
  );
}
