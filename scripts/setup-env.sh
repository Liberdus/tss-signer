#!/bin/bash

# Exit on error
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${GREEN}==================================${NC}"
echo -e "${GREEN}Development Environment Setup${NC}"
echo -e "${GREEN}==================================${NC}\n"

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}Please run this script as root or with sudo${NC}"
    exit 1
fi

# Check if customer user already exists
if id "customer" &>/dev/null; then
    echo -e "${YELLOW}User 'customer' already exists.${NC}"
    read -p "Do you want to continue with existing user? (y/n): " -n 1 -r < /dev/tty
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
    USER_EXISTS=true
else
    USER_EXISTS=false
fi

# Create customer user if doesn't exist
if [ "$USER_EXISTS" = false ]; then
    echo -e "${YELLOW}Creating user 'customer'...${NC}"

    # Ask for password
    while true; do
        read -s -p "Enter password for 'customer' user: " PASSWORD < /dev/tty
        echo
        read -s -p "Confirm password: " PASSWORD_CONFIRM < /dev/tty
        echo

        if [ "$PASSWORD" = "$PASSWORD_CONFIRM" ]; then
            break
        else
            echo -e "${RED}Passwords do not match. Please try again.${NC}"
        fi
    done

    # Create user with home directory
    useradd -m -s /bin/bash customer

    # Set password
    echo "customer:$PASSWORD" | chpasswd

    # Add to sudo group (optional - comment out if not needed)
    usermod -aG sudo customer

    echo -e "${GREEN}User 'customer' created successfully!${NC}\n"
fi

AUTHORIZED_KEY="${CUSTOMER_SSH_AUTHORIZED_KEY:-}"

if [ -n "$AUTHORIZED_KEY" ]; then
    install -d -m 700 -o customer -g customer /home/customer/.ssh
    touch /home/customer/.ssh/authorized_keys
    chown customer:customer /home/customer/.ssh/authorized_keys
    chmod 600 /home/customer/.ssh/authorized_keys

    echo -e "${YELLOW}Adding provided SSH public key to customer authorized_keys...${NC}"
    printf '%s\n' "$AUTHORIZED_KEY" >> /home/customer/.ssh/authorized_keys
fi

# Update package lists
echo -e "${YELLOW}Updating package lists...${NC}"
apt-get update

# Install build essentials and common dependencies
echo -e "${YELLOW}Installing build tools and dependencies...${NC}"
apt-get install -y build-essential curl wget git libssl-dev pkg-config

echo -e "${GREEN}Build tools installed successfully!${NC}\n"

# Create installation script for customer user
INSTALL_SCRIPT="/tmp/install_dev_tools.sh"
cat > "$INSTALL_SCRIPT" << 'SCRIPT_END'
#!/bin/bash

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}Installing development tools for user: $(whoami)${NC}\n"

# Detect shell profile
PROFILE_FILE="$HOME/.bashrc"

# Install NVM
echo -e "${YELLOW}Installing NVM...${NC}"
if [ -d "$HOME/.nvm" ]; then
    echo -e "${YELLOW}NVM directory already exists. Skipping NVM installation.${NC}"
else
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
fi

# Ensure NVM is in profile
if ! grep -q 'NVM_DIR' "$PROFILE_FILE" 2>/dev/null; then
    echo -e "${YELLOW}Adding NVM to $PROFILE_FILE${NC}"
    cat >> "$PROFILE_FILE" << 'EOF'

# NVM configuration
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"
EOF
fi

# Load NVM in current script
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# Install Node.js v20
echo -e "${YELLOW}Installing Node.js v20...${NC}"
nvm install 20
nvm use 20
nvm alias default 20

echo -e "${GREEN}Node.js installed!${NC}"
node --version
npm --version

# Install PM2 (process manager for TSS party nodes)
echo -e "\n${YELLOW}Installing PM2...${NC}"
npm install -g pm2
echo -e "${GREEN}PM2 installed!${NC}"

# Clone and build TSS signer
echo -e "\n${YELLOW}Cloning and building TSS signer...${NC}"
git clone https://github.com/Liberdus/tss-signer.git
cd tss-signer
npm install
npm run compile
echo -e "${GREEN}TSS signer TypeScript compiled successfully!${NC}"

# Fetch the upstream tss submodule
echo -e "\n${YELLOW}Fetching native TSS submodule...${NC}"
git submodule update --init --recursive

# Bootstrap vendored Go toolchain if system go is missing or wrong version
echo -e "\n${YELLOW}Bootstrapping Go toolchain (if needed)...${NC}"
if ! command -v go &>/dev/null || [[ "$(go version 2>/dev/null)" != *"go1.20"* ]]; then
    ./tss-tools/setup-mise-go.sh
fi

# Build the native BNB TSS binary
echo -e "\n${YELLOW}Building native BNB TSS binary...${NC}"
npm run tss-build
echo -e "${GREEN}Native TSS binary built successfully!${NC}"

# Print installation summary
echo -e "\n${GREEN}==================================${NC}"
echo -e "${GREEN}Installation completed successfully!${NC}"
echo -e "${GREEN}==================================${NC}"
echo -e "\n${YELLOW}Installed versions:${NC}"
echo -e "NVM: $(nvm --version)"
echo -e "Node.js: $(node --version)"
echo -e "NPM: $(npm --version)"
echo -e "PM2: $(pm2 --version)"

echo -e "\n${BLUE}Tools have been installed for user: $(whoami)${NC}"
SCRIPT_END

# Make the script executable
chmod +x "$INSTALL_SCRIPT"

# Run the installation script as customer user
echo -e "${BLUE}Switching to 'customer' user to install development tools...${NC}\n"
su - customer -c "bash $INSTALL_SCRIPT"

# Clean up
rm -f "$INSTALL_SCRIPT"

echo -e "\n${GREEN}==================================${NC}"
echo -e "${GREEN}All installations completed!${NC}"
echo -e "${GREEN}==================================${NC}"
echo -e "\n${YELLOW}Switch to the customer user to continue setup:${NC}"
echo -e "  ${GREEN}su - customer${NC}"
echo -e "\n${YELLOW}TSS signer is at:${NC}"
echo -e "  ${GREEN}~/tss-signer${NC}"
echo -e "\n${YELLOW}Next: follow PARTY_SETUP.md for native TSS init, keygen, and starting the observer + party.${NC}"
