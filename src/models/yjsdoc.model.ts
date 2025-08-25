import { Schema, model, Document } from "mongoose";

export interface IYjsDoc extends Document {
  _id: string; // canvasId
  data: Buffer;
}
const YjsDocSchema = new Schema<IYjsDoc>(
  {
    _id: String, // Mongoose가 ObjectId를 자동 생성하지 않도록 String으로 명시
    data: { type: Buffer, required: true },
  },
  { timestamps: true }
);
export const YjsDocModel = model<IYjsDoc>("YjsDoc", YjsDocSchema);
