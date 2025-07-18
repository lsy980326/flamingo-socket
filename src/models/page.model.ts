import { Schema, model, Document } from "mongoose";

export interface IPage extends Document {
  projectId: string; // PostgreSQL의 Project UUID
  name: string;
  order: number;
}

const PageSchema = new Schema<IPage>(
  {
    projectId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    order: { type: Number, required: true, default: 0 },
  },
  {
    timestamps: true,
  }
);

export const PageModel = model<IPage>("Page", PageSchema);
