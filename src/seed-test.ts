import { prisma } from "./lib/prisma.js";

async function main() {
    const account_ID = await prisma.accounts.findMany({
        where: {
        tenant_id: process.env.DEFAULT_TENANT_ID
        }
    })
    console.log(account_ID);
}

main()