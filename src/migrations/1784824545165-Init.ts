import { MigrationInterface, QueryRunner } from "typeorm";

export class Init1784824545165 implements MigrationInterface {
    name = 'Init1784824545165'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // uuid_generate_v4() default on every PK requires uuid-ossp.
        await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
        await queryRunner.query(`CREATE TABLE "pbx_connections" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying NOT NULL, "mode" character varying NOT NULL DEFAULT 'direct', "connectorTokenHash" character varying, "host" character varying NOT NULL, "port" integer NOT NULL DEFAULT '5038', "username" character varying NOT NULL, "secretEnc" character varying NOT NULL, CONSTRAINT "UQ_147fec88bf5a658d8c50fd953ba" UNIQUE ("name"), CONSTRAINT "PK_96dbf397a6d4eba99cdeeb729e2" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "tenants" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "slug" character varying NOT NULL, "name" character varying NOT NULL, "pbxConnectionId" uuid NOT NULL, "extensionPattern" character varying NOT NULL, "contexts" text NOT NULL, "originateContext" character varying NOT NULL, "originateChannelTemplate" character varying NOT NULL, "apiKeyHash" character varying NOT NULL, "webhookUrl" character varying, "webhookSecretEnc" character varying, CONSTRAINT "UQ_2310ecc5cb8be427097154b18fc" UNIQUE ("slug"), CONSTRAINT "UQ_709d3381113f521a1900eca4b33" UNIQUE ("apiKeyHash"), CONSTRAINT "PK_53be67a04681c66b87ee27c9321" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "agents" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenantId" uuid NOT NULL, "ext" character varying NOT NULL, "displayName" character varying NOT NULL, "crmRefs" jsonb NOT NULL DEFAULT '{}', CONSTRAINT "PK_9c653f28ae19c5884d5baf6a1d9" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_2876e49e9d8e2b1cbd7a75d6d0" ON "agents"  ("tenantId", "ext") `);
        await queryRunner.query(`CREATE TABLE "crm_integrations" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenantId" uuid NOT NULL, "type" character varying NOT NULL, "enabled" boolean NOT NULL DEFAULT true, "config" jsonb NOT NULL DEFAULT '{}', "secretsEnc" character varying NOT NULL, CONSTRAINT "PK_0ecc13ac0853ad8b7dbc6bf77f3" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_7635a53928c32b68758d427b47" ON "crm_integrations"  ("tenantId", "type") `);
        await queryRunner.query(`ALTER TABLE "tenants" ADD CONSTRAINT "FK_c6661a3c257f100fe4aa597f093" FOREIGN KEY ("pbxConnectionId") REFERENCES "pbx_connections"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "agents" ADD CONSTRAINT "FK_388079d7d4e52de7d14a939303a" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "crm_integrations" ADD CONSTRAINT "FK_ab23ca45f25ef0d8c7a304c0c7f" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "crm_integrations" DROP CONSTRAINT "FK_ab23ca45f25ef0d8c7a304c0c7f"`);
        await queryRunner.query(`ALTER TABLE "agents" DROP CONSTRAINT "FK_388079d7d4e52de7d14a939303a"`);
        await queryRunner.query(`ALTER TABLE "tenants" DROP CONSTRAINT "FK_c6661a3c257f100fe4aa597f093"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_7635a53928c32b68758d427b47"`);
        await queryRunner.query(`DROP TABLE "crm_integrations"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_2876e49e9d8e2b1cbd7a75d6d0"`);
        await queryRunner.query(`DROP TABLE "agents"`);
        await queryRunner.query(`DROP TABLE "tenants"`);
        await queryRunner.query(`DROP TABLE "pbx_connections"`);
    }

}
