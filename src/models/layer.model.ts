import { Schema, model, Document } from "mongoose";

export type LayerType = "brush" | "text" | "shape" | "image";
export type BlendMode =
  | "normal"
  | "multiply"
  | "screen"
  | "overlay"
  | "soft-light"
  | "hard-light"
  | "color-dodge"
  | "color-burn"
  | "darken"
  | "lighten"
  | "difference"
  | "exclusion";

export interface ILayerData extends Document {
  // ... (나중에 스트로크, 텍스트 내용 등 추가)
}

export interface ILayer extends Document {
  canvasId: Schema.Types.ObjectId;
  projectId: string;
  name: string;
  order: number;
  type: LayerType;
  blendMode: BlendMode;
  opacity: number; // 0-100
  isVisible: boolean;
  isLocked: boolean;
  data: ILayerData; // 실제 그림 데이터
}

const LayerSchema = new Schema<ILayer>(
  {
    canvasId: {
      type: Schema.Types.ObjectId,
      ref: "Canvas",
      required: true,
      index: true,
    },
    projectId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    order: { type: Number, required: true, default: 0 },
    type: {
      type: String,
      enum: ["brush", "text", "shape", "image"],
      required: true,
    },
    blendMode: {
      type: String,
      enum: [
        "normal",
        "multiply",
        "screen",
        "overlay",
        "soft-light",
        "hard-light",
        "color-dodge",
        "color-burn",
        "darken",
        "lighten",
        "difference",
        "exclusion",
      ],
      default: "normal",
    },
    opacity: { type: Number, min: 0, max: 100, default: 100 },
    isVisible: { type: Boolean, default: true },
    isLocked: { type: Boolean, default: false },
    data: { type: Schema.Types.Mixed, default: {} }, // 어떤 객체든 저장 가능
  },
  {
    timestamps: true,
  }
);

export const LayerModel = model<ILayer>("Layer", LayerSchema);
