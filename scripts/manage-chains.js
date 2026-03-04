#!/usr/bin/env node

/**
 * Chain Configuration Management Script
 * 
 * This script helps manage chain configurations for the multi-chain bridge.
 * Usage:
 *   node manage-chains.js list                    # List all configured chains
 *   node manage-chains.js add <chainId>           # Add a new chain interactively
 *   node manage-chains.js validate               # Validate current configuration
 *   node manage-chains.js generate-addresses     # Generate bridge addresses for all chains
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const CONFIG_FILE = path.join(__dirname, '..', 'chain-config.json');

function loadConfig() {
    if (!fs.existsSync(CONFIG_FILE)) {
        console.error('Chain configuration file not found:', CONFIG_FILE);
        process.exit(1);
    }
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

function saveConfig(config) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function listChains() {
    const config = loadConfig();
    console.log('\n📋 Configured Chains:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    Object.entries(config.supportedChains).forEach(([chainId, chainConfig]) => {
        console.log(`\n🔗 ${chainConfig.name} (Chain ID: ${chainId})`);
        console.log(`   RPC URL: ${chainConfig.rpcUrl}`);
        console.log(`   Contract: ${chainConfig.contractAddress}`);
        console.log(`   TSS Address: ${chainConfig.tssSenderAddress}`);
        console.log(`   Bridge Address: ${chainConfig.bridgeAddress}`);
        console.log(`   Gas Limit: ${chainConfig.gasConfig.gasLimit}`);
        console.log(`   Gas Tiers: ${chainConfig.gasConfig.gasPriceTiers.join(', ')} gwei`);
    });
    
    console.log(`\n🌟 Default Chain: ${config.defaultChain} (${config.supportedChains[config.defaultChain]?.name || 'Unknown'})`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

async function addChain(chainId) {
    const config = loadConfig();
    
    if (config.supportedChains[chainId]) {
        console.error(`❌ Chain ${chainId} already exists!`);
        return;
    }
    
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    
    const question = (prompt) => new Promise((resolve) => rl.question(prompt, resolve));
    
    try {
        console.log(`\n➕ Adding new chain with ID: ${chainId}`);
        console.log('Please provide the following information:\n');
        
        const name = await question('Chain name (e.g., "Ethereum Mainnet"): ');
        const rpcUrl = await question('RPC URL (include placeholder for API key if needed): ');
        const contractAddress = await question('Bridge contract address (0x...): ');
        const tssSenderAddress = await question('TSS sender address (0x...): ');
        const gasLimit = await question('Gas limit (default: 200000): ') || '200000';
        const gasTiers = await question('Gas price tiers in gwei (comma-separated, e.g., "10,20,30"): ');
        
        // Generate bridge address based on chain index
        const chainIndex = Object.keys(config.supportedChains).length.toString().padStart(6, '0');
        const baseBridgeAddress = 'eacb10fb8e61b0f382c0b3f25b6ffcdb985ea5af';
        const bridgeAddress = baseBridgeAddress + '0'.repeat(18) + chainIndex;
        
        const newChain = {
            name: name.trim(),
            chainId: parseInt(chainId),
            rpcUrl: rpcUrl.trim(),
            contractAddress: contractAddress.trim(),
            tssSenderAddress: tssSenderAddress.trim(),
            bridgeAddress: bridgeAddress,
            gasConfig: {
                gasLimit: parseInt(gasLimit),
                gasPriceTiers: gasTiers.split(',').map(tier => parseInt(tier.trim()))
            }
        };
        
        config.supportedChains[chainId] = newChain;
        saveConfig(config);
        
        console.log(`\n✅ Successfully added ${name}!`);
        console.log(`🏠 Generated bridge address: ${bridgeAddress}`);
        
    } catch (error) {
        console.error('❌ Error adding chain:', error.message);
    } finally {
        rl.close();
    }
}

function validateConfig() {
    try {
        const config = loadConfig();
        let isValid = true;
        
        console.log('\n🔍 Validating chain configuration...\n');
        
        // Check if supportedChains exists
        if (!config.supportedChains) {
            console.error('❌ Missing supportedChains object');
            isValid = false;
        }
        
        // Check if defaultChain exists and is valid
        if (!config.defaultChain) {
            console.error('❌ Missing defaultChain');
            isValid = false;
        } else if (!config.supportedChains[config.defaultChain]) {
            console.error(`❌ Default chain ${config.defaultChain} not found in supportedChains`);
            isValid = false;
        }
        
        // Validate each chain
        Object.entries(config.supportedChains).forEach(([chainId, chainConfig]) => {
            console.log(`Validating ${chainConfig.name} (${chainId})...`);
            
            const required = ['name', 'chainId', 'rpcUrl', 'contractAddress', 'tssSenderAddress', 'bridgeAddress'];
            const missing = required.filter(field => !chainConfig[field]);
            
            if (missing.length > 0) {
                console.error(`❌ Missing required fields: ${missing.join(', ')}`);
                isValid = false;
            }
            
            if (chainConfig.chainId !== parseInt(chainId)) {
                console.error(`❌ Chain ID mismatch: key=${chainId}, value=${chainConfig.chainId}`);
                isValid = false;
            }
            
            if (!chainConfig.gasConfig || !chainConfig.gasConfig.gasLimit || !Array.isArray(chainConfig.gasConfig.gasPriceTiers)) {
                console.error(`❌ Invalid gasConfig structure`);
                isValid = false;
            }
            
            // Check address formats
            const addressFields = ['contractAddress', 'tssSenderAddress'];
            addressFields.forEach(field => {
                if (chainConfig[field] && !chainConfig[field].match(/^0x[a-fA-F0-9]{40}$/)) {
                    console.error(`❌ Invalid ${field} format: ${chainConfig[field]}`);
                    isValid = false;
                }
            });
            
            if (isValid) {
                console.log(`✅ ${chainConfig.name} validation passed`);
            }
        });
        
        if (isValid) {
            console.log('\n🎉 Configuration validation passed!');
        } else {
            console.log('\n❌ Configuration validation failed!');
            process.exit(1);
        }
        
    } catch (error) {
        console.error('❌ Error validating configuration:', error.message);
        process.exit(1);
    }
}

function generateAddresses() {
    const config = loadConfig();
    
    console.log('\n🏠 Bridge Addresses for All Chains:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    Object.entries(config.supportedChains).forEach(([chainId, chainConfig], index) => {
        console.log(`\n🔗 ${chainConfig.name} (Chain ID: ${chainId})`);
        console.log(`   Bridge Address: ${chainConfig.bridgeAddress}`);
        console.log(`   Usage: Send LIB tokens to this address to bridge to ${chainConfig.name}`);
    });
    
    console.log('\n💡 Note: Users send LIB tokens to these addresses on Liberdus to bridge to the corresponding EVM chain.');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

function showHelp() {
    console.log(`
🌉 Multi-Chain Bridge Configuration Manager

Usage:
  node manage-chains.js <command> [options]

Commands:
  list                    List all configured chains
  add <chainId>          Add a new chain interactively
  validate               Validate current configuration
  generate-addresses     Show bridge addresses for all chains
  help                   Show this help message

Examples:
  node manage-chains.js list
  node manage-chains.js add 1
  node manage-chains.js validate
  node manage-chains.js generate-addresses
`);
}

// Main execution
const command = process.argv[2];
const arg = process.argv[3];

switch (command) {
    case 'list':
        listChains();
        break;
    case 'add':
        if (!arg) {
            console.error('❌ Please provide a chain ID');
            console.log('Usage: node manage-chains.js add <chainId>');
            process.exit(1);
        }
        addChain(arg);
        break;
    case 'validate':
        validateConfig();
        break;
    case 'generate-addresses':
        generateAddresses();
        break;
    case 'help':
        showHelp();
        break;
    default:
        console.error('❌ Unknown command:', command);
        showHelp();
        process.exit(1);
}
