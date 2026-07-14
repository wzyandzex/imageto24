import {
  MODEL_CATALOG,
  modelLimitationSummary,
  resolveModelRouting,
  type AiModelMetadata,
} from "@/pipeline";

export interface ModelRoutingControlProps {
  decision: ReturnType<typeof resolveModelRouting>;
  context: Parameters<typeof resolveModelRouting>[0];
  overrideId: string;
  setOverrideId: (id: string) => void;
}

export function ModelRoutingControl({
  decision,
  context,
  overrideId,
  setOverrideId,
}: ModelRoutingControlProps) {
  const selectableModels = selectableModelsForContext(context);
  const unavailableModels = MODEL_CATALOG.filter((model) => !selectableModels.includes(model));
  return (
    <div className="flex flex-col gap-3" data-testid="model-routing-control">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">Model routing</p>
        <p className="text-xs text-muted-foreground" data-testid="model-routing-recommendation">
          Automatic recommendation: {decision.model.displayName}. {decision.model.description}
        </p>
        <p className="text-xs text-muted-foreground" data-testid="model-routing-limitations">
          {modelLimitationSummary(decision.model, context)}
        </p>
        {decision.reason && (
          <p className="text-xs text-muted-foreground" data-testid="model-routing-fallback">
            {decision.reason}
          </p>
        )}
      </div>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Expert model override</span>
        <select
          value={overrideId}
          onChange={(e) => setOverrideId(e.target.value)}
          data-testid="model-routing-override"
          className="rounded-md border border-input bg-background px-3 py-2 text-sm"
        >
          <option value="auto">Automatic — best model for this run</option>
          {selectableModels.map((model) => (
            <option key={model.id} value={model.id}>
              {model.displayName} — {modelPickerLabel(model)}
            </option>
          ))}
          {unavailableModels.map((model) => (
            <option key={model.id} value={model.id} disabled>
              {model.displayName} — {modelLimitationSummary(model, context)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function selectableModelsForContext(context: Parameters<typeof resolveModelRouting>[0]): AiModelMetadata[] {
  return MODEL_CATALOG.filter((model) =>
    model.availabilityState === "available" &&
    model.availability.includes(context.runtimeTarget) &&
    model.supportedSourceTypes.includes(context.sourceType)
  );
}

function modelPickerLabel(model: AiModelMetadata): string {
  const runtime = model.runtimeTarget === "cloud" ? "cloud" : "local";
  const stability = model.stability === "experimental" ? "experimental" : "stable";
  const alpha = model.alphaSupport === "rgb-only" ? "RGB-only" : "alpha-aware";
  return `${runtime}, ${stability}, ${alpha}`;
}
