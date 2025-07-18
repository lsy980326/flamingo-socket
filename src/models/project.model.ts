import { Schema, model, Document } from "mongoose";

export interface IProject extends Document {
  _id: string; // PostgreSQL의 UUID를 _id로 사용
  name: string;
  ownerId: number;
  collaborators: { userId: number; role: string }[];
  createdAt: Date;
  updatedAt: Date;
}

const ProjectSchema = new Schema<IProject>(
  {
    _id: { type: String, required: true },
    name: { type: String, required: true },
    ownerId: { type: Number, required: true, index: true },
    collaborators: [
      {
        userId: { type: Number, required: true },
        role: {
          type: String,
          enum: ["owner", "editor", "viewer"],
          required: true,
        },
        _id: false,
      },
    ],
  },
  {
    timestamps: true, // createdAt, updatedAt 자동 생성
    _id: false, // Mongoose가 자동으로 _id를 생성하지 않도록 함
  }
);

export const ProjectModel = model<IProject>("Project", ProjectSchema);
