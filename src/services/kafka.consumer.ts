import { Kafka, Consumer } from "kafkajs";
import { createMechanism } from "@jm18457/kafkajs-msk-iam-authentication-mechanism";
import { ProjectModel } from "../models/project.model";

const kafka = new Kafka({
  clientId: "flamingo-socket-server", // 클라이언트 ID는 구분되게 설정
  brokers: process.env.KAFKA_BROKERS!.split(","),
  ssl: true,
  sasl: createMechanism({
    region: process.env.AWS_REGION || "ap-northeast-2",
  }),
});

const consumer: Consumer = kafka.consumer({ groupId: "flamingo-socket-group" });

export const connectConsumer = async () => {
  await consumer.connect();
  console.log("✅ Kafka Consumer connected");

  await consumer.subscribe({ topic: "PROJECTS_V1", fromBeginning: true });
  await consumer.subscribe({ topic: "COLLABORATORS_V1", fromBeginning: true });

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      if (!message.value) return;

      console.log(
        `[Kafka] Message received on topic ${topic}: ${message.value.toString()}`
      );
      const payload = JSON.parse(message.value.toString());

      if (topic === "PROJECTS_V1") {
        switch (payload.event) {
          case "PROJECT_CREATED": {
            const { id, name, owner_id } = payload.data;
            const ownerIdNum = Number(owner_id);
            await ProjectModel.create({
              _id: id,
              name,
              ownerId: ownerIdNum,
              collaborators: [{ userId: ownerIdNum, role: "owner" }],
            });
            console.log(`[DB] Project ${id} created in MongoDB.`);
            break;
          }
          case "PROJECT_DELETED": {
            const { projectId } = payload.data;
            const result = await ProjectModel.deleteOne({ _id: projectId });

            if (result.deletedCount > 0) {
              console.log(`[DB] Project ${projectId} deleted from MongoDB.`);
            } else {
              console.warn(
                `[DB] Project ${projectId} to delete was not found in MongoDB.`
              );
            }
            break;
          }
        }
      }

      if (topic === "COLLABORATORS_V1") {
        const projectId = payload.data.projectId;
        const userId = Number(payload.data.userId);
        const role = payload.data.role;
        const newRole = payload.data.newRole;

        switch (payload.event) {
          case "COLLABORATOR_ADDED":
            await ProjectModel.updateOne(
              { _id: projectId },
              { $push: { collaborators: { userId, role } } }
            );
            console.log(
              `[DB] Collaborator ${userId} added to project ${projectId}`
            );
            break;

          case "COLLABORATOR_ROLE_UPDATED":
            await ProjectModel.updateOne(
              { _id: projectId, "collaborators.userId": userId },
              { $set: { "collaborators.$.role": newRole } }
            );
            console.log(
              `[DB] Collaborator ${userId}'s role updated in project ${projectId}`
            );
            break;

          case "COLLABORATOR_REMOVED":
            await ProjectModel.updateOne(
              { _id: projectId },
              { $pull: { collaborators: { userId: userId } } }
            );
            console.log(
              `[DB] Collaborator ${userId} removed from project ${projectId}`
            );
            break;
        }
      }
    },
  });
};
