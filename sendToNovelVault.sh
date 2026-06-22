# Build and send plugin to vaults
# Get the current folder name dynamically
PLUGIN_NAME=$(basename "$PWD")

npm run build

# create the distribution directory
mkdir -p "$PLUGIN_NAME"

# copy the built files into it (outputs are in root, not dist)
cp main.js "$PLUGIN_NAME"
cp manifest.json "$PLUGIN_NAME"
cp styles.css "$PLUGIN_NAME"

# send to my novel writing vault
cp -r "$PLUGIN_NAME" "/Users/caffae/Notes/Novel-Writing/.obsidian/plugins/"
cp -r "$PLUGIN_NAME" "/Users/caffae/Notes/ZettelPublish (Content Creator V2 April 2025)/.obsidian/plugins/"
cp -r "$PLUGIN_NAME" "/Users/caffae/Notes/Journal/.obsidian/plugins/"

echo "Updated $PLUGIN_NAME plugin in novel writing, journal and zettelpublish folders"
