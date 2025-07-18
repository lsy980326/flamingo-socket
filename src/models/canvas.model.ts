import { Schema, model, Document } from "mongoose";

// 명세서의 SizeUnit 타입
export type SizeUnit = "px" | "mm" | "cm" | "in" | "pt";

export interface ICanvas extends Document {
  pageId: Schema.Types.ObjectId; // 부모 페이지 ID
  projectId: string; // 빠른 조회를 위한 비정규화된 데이터
  name: string;
  order: number;
  width: number;
  height: number;
  unit: SizeUnit;
}

const CanvasSchema = new Schema<ICanvas>(
  {
    pageId: {
      type: Schema.Types.ObjectId,
      ref: "Page",
      required: true,
      index: true,
    },
    projectId: { type: String, required: true, index: true }, // 페이지 생성 시 projectId를 함께 저장
    name: { type: String, required: true },
    order: { type: Number, required: true, default: 0 },
    width: { type: Number, required: true },
    height: { type: Number, required: true },
    unit: { type: String, enum: ["px", "mm", "cm", "in", "pt"], default: "px" },
  },
  {
    timestamps: true,
  }
);

export const CanvasModel = model<ICanvas>("Canvas", CanvasSchema);
