

## commands needed
Install:
sudo apt update && sudo apt install npm --fix-missing

cd frontend && npm install
npm install && npm run dev
npm run dev


## Install nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash

export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"

nvm install 20
nvm use 20
nvm alias default 20

# TODO:
Fix versions for frontend