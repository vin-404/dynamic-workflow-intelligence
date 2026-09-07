"use client";

import { useState, useEffect } from "react";
import { getAccuracy, AccuracyResult, DEMO_PROJECT_ID } from "@/lib/api";
import Card, { CardTitle } from "./Card";

export default function AccuracyPanel() {
  const [data, setData] = useState<AccuracyResult | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getAccuracy(DEMO_PROJECT_ID)
      .then(setData)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <Card>
        <CardTitle>Engine Accuracy</CardTitle>
        <p className="text-sm text-dim">Verifying detector accuracy...</p>
      </Card>
    );
  }

  if (!data) return null;

  const perfect = data.recall === 1.0 && data.precision_vs_planted === 1.0;

  return (
    <Card>
      <CardTitle>Engine Accuracy Verification</CardTitle>

      <div className="flex gap-6 flex-wrap mb-4">
        <div className="text-center">
          <div
            className={`text-3xl font-bold tabular-nums ${perfect ? "text-green" : "text-red"}`}
          >
            {(data.recall * 100).toFixed(0)}%
          </div>
          <div className="text-xs text-dim">Recall</div>
        </div>
        <div className="text-center">
          <div
            className={`text-3xl font-bold tabular-nums ${perfect ? "text-green" : "text-red"}`}
          >
            {(data.precision_vs_planted * 100).toFixed(0)}%
          </div>
          <div className="text-xs text-dim">Precision</div>
        </div>
        <div className="text-center">
          <div className="text-3xl font-bold tabular-nums text-accent">
            {data.planted}
          </div>
          <div className="text-xs text-dim">Faults Planted</div>
        </div>
        <div className="text-center">
          <div className="text-3xl font-bold tabular-nums text-accent">
            {data.detected}
          </div>
          <div className="text-xs text-dim">Faults Detected</div>
        </div>
      </div>

      {perfect && (
        <div className="p-3 bg-green/5 border border-green/20 rounded-md mb-4">
          <p className="text-sm text-green font-medium">
            All {data.planted} planted faults detected with zero false
            positives.
          </p>
        </div>
      )}

      <div className="space-y-2">
        <h3 className="text-xs uppercase tracking-wider text-dim font-medium">
          Ground Truth vs Detection
        </h3>
        {Object.entries(data.ground_truth).map(([key, desc]) => {
          const detected = data.true_positives.includes(key);
          return (
            <div
              key={key}
              className="flex items-start gap-3 p-2.5 bg-panel2 rounded-md"
            >
              <span
                className={`text-xs px-2 py-0.5 rounded-full shrink-0 mt-0.5 ${
                  detected
                    ? "bg-green/15 text-green"
                    : "bg-red/15 text-red"
                }`}
              >
                {detected ? "detected" : "missed"}
              </span>
              <div>
                <code className="text-xs text-accent">{key}</code>
                <span className="text-[13px] text-dim ml-2">{desc}</span>
              </div>
            </div>
          );
        })}
      </div>

      {data.extra.length > 0 && (
        <div className="mt-3">
          <h3 className="text-xs uppercase tracking-wider text-dim font-medium mb-1">
            Extra Detections (not in ground truth)
          </h3>
          {data.extra.map((e) => (
            <code
              key={e}
              className="bg-amber/10 text-amber px-2 py-0.5 rounded text-xs mr-2"
            >
              {e}
            </code>
          ))}
        </div>
      )}

      <p className="text-xs text-dim mt-4 leading-relaxed">
        This verification compares the engine&apos;s output against 3
        deliberately planted faults in the demo scenario. The engine uses 4
        deterministic detectors — no ML, no training data. Impact score =
        days_lost x (1 + downstream_tasks).
      </p>
    </Card>
  );
}
