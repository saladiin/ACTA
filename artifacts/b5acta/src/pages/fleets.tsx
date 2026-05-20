import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListFleets,
  useCreateFleet,
  useDeleteFleet,
  useListFleetShips,
  useListShipModels,
  useAddShipToFleet,
  useRemoveShipFromFleet,
  getListFleetsQueryKey,
  getListFleetShipsQueryKey,
} from "@workspace/api-client-react";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Trash2, Plus, ChevronRight, ChevronDown, Ship, Crosshair } from "lucide-react";
import { useForm } from "react-hook-form";

function FleetDetail({ fleetId }: { fleetId: number }) {
  const qc = useQueryClient();
  const { data: ships, isLoading } = useListFleetShips(fleetId, { query: { queryKey: getListFleetShipsQueryKey(fleetId) } });
  const { data: models } = useListShipModels();
  const addShip = useAddShipToFleet();
  const removeShip = useRemoveShipFromFleet();
  const [addOpen, setAddOpen] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [shipName, setShipName] = useState("");

  const handleAddShip = () => {
    if (!selectedModel || !shipName) return;
    addShip.mutate(
      { fleetId, data: { shipModelId: parseInt(selectedModel), name: shipName } },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getListFleetShipsQueryKey(fleetId) });
          qc.invalidateQueries({ queryKey: getListFleetsQueryKey() });
          setAddOpen(false);
          setSelectedModel("");
          setShipName("");
        },
      }
    );
  };

  if (isLoading) return <div className="px-4 pb-4"><Skeleton className="h-20 w-full" /></div>;

  return (
    <div className="px-4 pb-4">
      <div className="space-y-1.5 mb-3">
        {ships?.length === 0 && (
          <div className="text-xs text-muted-foreground py-3 text-center border border-dashed border-border rounded">No ships assigned</div>
        )}
        {ships?.map(ship => (
          <div key={ship.id} data-testid={`card-ship-${ship.id}`} className="flex items-center justify-between bg-secondary/30 border border-border rounded px-3 py-2">
            <div>
              <div className="text-sm font-medium">{ship.name}</div>
              <div className="text-xs text-muted-foreground font-mono">{ship.shipModel?.faction} &mdash; {ship.shipModel?.pointCost} pts &mdash; HP: {ship.shipModel?.hullPoints}</div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              data-testid={`button-remove-ship-${ship.id}`}
              className="w-7 h-7 text-muted-foreground hover:text-destructive"
              onClick={() => removeShip.mutate({ fleetId, shipId: ship.id }, { onSuccess: () => { qc.invalidateQueries({ queryKey: getListFleetShipsQueryKey(fleetId) }); qc.invalidateQueries({ queryKey: getListFleetsQueryKey() }); } })}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </div>
        ))}
      </div>
      <Button size="sm" variant="outline" className="gap-1.5 text-xs uppercase tracking-wider" data-testid="button-add-ship" onClick={() => setAddOpen(true)}>
        <Plus className="w-3 h-3" /> Add Ship
      </Button>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="bg-card border-border">
          <DialogHeader>
            <DialogTitle className="text-sm uppercase tracking-widest text-primary">Assign Ship</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <Select value={selectedModel} onValueChange={setSelectedModel}>
              <SelectTrigger data-testid="select-ship-model" className="bg-background">
                <SelectValue placeholder="Select ship class..." />
              </SelectTrigger>
              <SelectContent className="bg-card border-border">
                {models?.map(m => (
                  <SelectItem key={m.id} value={String(m.id)}>
                    {m.name} ({m.faction}) &mdash; {m.pointCost} pts
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              data-testid="input-ship-name"
              placeholder="Ship name (e.g. EAS Agamemnon)"
              value={shipName}
              onChange={e => setShipName(e.target.value)}
              className="bg-background"
            />
          </div>
          <DialogFooter>
            <Button onClick={handleAddShip} disabled={!selectedModel || !shipName || addShip.isPending} className="uppercase tracking-widest text-xs">
              {addShip.isPending ? "Assigning..." : "Assign Ship"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function Fleets() {
  const qc = useQueryClient();
  const { data: fleets, isLoading } = useListFleets();
  const createFleet = useCreateFleet();
  const deleteFleet = useDeleteFleet();
  const [createOpen, setCreateOpen] = useState(false);
  const [expandedFleet, setExpandedFleet] = useState<number | null>(null);
  const { register, handleSubmit, reset, formState: { errors } } = useForm<{ name: string }>();

  const onCreateFleet = (data: { name: string }) => {
    createFleet.mutate(
      { data: { name: data.name } },
      {
        onSuccess: (fleet) => {
          qc.invalidateQueries({ queryKey: getListFleetsQueryKey() });
          setCreateOpen(false);
          reset();
          setExpandedFleet(fleet.id);
        },
      }
    );
  };

  return (
    <Layout title="Fleet Registry">
      <div className="p-6 max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <p className="text-xs text-muted-foreground font-mono tracking-wider">
            {fleets?.length ?? 0} fleet{fleets?.length !== 1 ? "s" : ""} on record
          </p>
          <Button size="sm" data-testid="button-create-fleet" onClick={() => setCreateOpen(true)} className="gap-2 uppercase tracking-widest text-xs font-bold">
            <Plus className="w-3 h-3" /> New Fleet
          </Button>
        </div>

        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : fleets?.length === 0 ? (
          <div className="border border-dashed border-border rounded-md py-16 text-center space-y-3">
            <Ship className="w-10 h-10 text-muted-foreground mx-auto opacity-30" />
            <p className="text-sm text-muted-foreground">No fleets registered. Build your first fleet.</p>
            <Button size="sm" onClick={() => setCreateOpen(true)} variant="outline" className="uppercase tracking-widest text-xs">
              <Plus className="w-3 h-3 mr-1" /> Create Fleet
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {fleets?.map(fleet => (
              <div key={fleet.id} data-testid={`card-fleet-${fleet.id}`} className="border border-border bg-card rounded-md overflow-hidden">
                <div
                  className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-secondary/30 transition-colors"
                  onClick={() => setExpandedFleet(expandedFleet === fleet.id ? null : fleet.id)}
                >
                  <div className="flex items-center gap-3">
                    <Crosshair className="w-4 h-4 text-primary" />
                    <div>
                      <div className="font-semibold text-sm tracking-wide">{fleet.name}</div>
                      <div className="text-xs text-muted-foreground font-mono">{fleet.shipCount} ships &mdash; {fleet.totalPoints} pts</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="w-7 h-7 text-muted-foreground hover:text-destructive"
                      data-testid={`button-delete-fleet-${fleet.id}`}
                      onClick={e => {
                        e.stopPropagation();
                        deleteFleet.mutate({ fleetId: fleet.id }, { onSuccess: () => qc.invalidateQueries({ queryKey: getListFleetsQueryKey() }) });
                      }}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                    {expandedFleet === fleet.id ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
                  </div>
                </div>
                {expandedFleet === fleet.id && <FleetDetail fleetId={fleet.id} />}
              </div>
            ))}
          </div>
        )}
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="bg-card border-border">
          <DialogHeader>
            <DialogTitle className="text-sm uppercase tracking-widest text-primary">Register New Fleet</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit(onCreateFleet)} className="space-y-4 py-2">
            <Input
              data-testid="input-fleet-name"
              placeholder="Fleet designation (e.g. 3rd Battle Group)"
              className="bg-background"
              {...register("name", { required: "Fleet name is required" })}
            />
            {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
            <DialogFooter>
              <Button type="submit" disabled={createFleet.isPending} className="uppercase tracking-widest text-xs font-bold">
                {createFleet.isPending ? "Registering..." : "Register Fleet"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Layout>
  );
}
