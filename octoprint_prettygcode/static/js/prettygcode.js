$(function () {
    console.log("Create PrettyGCode View Model");
    function PrettyGCodeViewModel(parameters) {
        var self = this;
        self.printerProfiles = parameters[2];
        
        //Parse terminal data for file and pos updates.
        var curJobName="";
        function updateJob(job){
            if (curJobName != job.file.path) {
                curJobName = job.file.path;
                if(viewInitialized && gcodeProxy)
                    gcodeProxy.loadGcode('/downloads/files/local/' + curJobName);
            }

        }
        self.fromHistoryData = function(data) {
            updateJob(data.job);
        };


        //used to animate the nozzle position in response to terminal messages
        function PrintHeadSimulator()
        {
            var buffer=[];
            var HeadState =function(){
                this.position=new THREE.Vector3(0,0,0);
                this.rate=50.0*60;
                this.extrude=0;
                this.clone=function(){
                    var newState=new HeadState();
                    newState.position.copy(this.position);
                    newState.rate=this.rate;
                    return(newState);
                }
            };
            var curState= new HeadState();
            var curEnd= new HeadState();
            var parserCurState= new HeadState();;

            this.getCurPosition=function(){
                return(curState.position);
            }

            //add gcode command to the buffer
            this.addCommand= function(cmd)
            {
                if(buffer.length>1000)
                {
                    console.log("PrintHeadSimulator buffer overflow")
                    return;
                }
                if(cmd.indexOf(" G")>-1)
                {
                    var x= parseFloat(cmd.split("X")[1])
                    if(!Number.isNaN(x))
                        parserCurState.position.x=x;
                    var y= parseFloat(cmd.split("Y")[1])
                    if(!Number.isNaN(y))
                        parserCurState.position.y=y;
                    var z= parseFloat(cmd.split("Z")[1])
                    if(!Number.isNaN(z))
                    {
                        parserCurState.position.z=z;
                    }
                    var f= parseFloat(cmd.split("F")[1])
                    if(!Number.isNaN(f))
                    {
                        parserCurState.rate=f;
                    }
                    buffer.push(parserCurState.clone());
                }
            }
            //Update the printhead position based on time elapsed.
            this.updatePosition=function(timeStep){

                //Convert the gcode feed rate (in MM/per min?) to rate per second.
                var rate = curState.rate/60.0;

                //adapt rate to keep up with buffer.
                if(buffer.length>10)
                {
                    rate=rate*(buffer.length/5.0);
                    //console.log(["Too Slow ",rate,buffer.length])
                }
                if(buffer.length<5)
                {
                    rate=rate*(1.0/(buffer.length*5.0));
                    //console.log(["Too fast ",rate,buffer.length])
                }

                //dist head needs to travel this frame
                var dist = rate*timeStep
                while(buffer.length>0 && dist >0)//while some place to go and some dist left.
                {
                    //direction
                    var vectToCurEnd=curEnd.position.clone().sub(curState.position);
                    var distToEnd=vectToCurEnd.length();
                    if(dist<distToEnd)//Inside current line?
                    {
                        //move pos the distance along line
                        vectToCurEnd.setLength(dist);
                        curState.position.add(vectToCurEnd);  
                        dist=0;//all done 
                    }else{
                        //move pos to end point.
                        curState.position.copy(curEnd.position);
                        curState.rate=curEnd.rate;
                        //subract dist for next loop.
                        dist=dist-distToEnd;

                        //start on next buffer command
                        buffer.shift();
                        if(buffer.length>0)
                            curEnd=buffer[0];
                        //draw segment
                        //todo.
                    }
                }
            }
        }

        var printHeadSim=new PrintHeadSimulator();
        self.fromCurrentData= function (data) {
            //update current loaded model.
            updateJob(data.job);

            //parse logs position data for simulator
            if(data.logs.length){
                data.logs.forEach(function(e,i)
                {
                    if(e.startsWith("Send:"))
                    {
                        //console.log(["GCmd:",e]);
                        printHeadSim.addCommand(e);
                    }
                })
            }
        };

        self.onAfterBinding = function () {
            //console.log("onAfterBinding")
        };
        self.onEventFileSelected = function (payload){
            //console.log(["onEventFileSelected ",payload])
        }

        //Scene globals
        var camera, cameraControls,cameraLight; 
        var scene, renderer; 
        var gcodeProxy;
        var cubeCamera;
        var nozzleModel;
        var clock;
        var dimensionsGroup;
        var sceneBounds = new THREE.Box3();
        //todo. Are these needed?
        var gcodeWid = 580;
        var gcodeHei = 580;
        var gui;

        var currentLayerNumber=0;

        //settings that are saved between sessions
        var PGSettings = function () {
            this.showMirror=true;
            this.fatLines=false;
            this.reflections=false;
            this.syncToProgress=false;
            this.reloadGcode = function () {
                if(gcodeProxy && curJobName!="")
                    gcodeProxy.loadGcode('/downloads/files/local/' + curJobName);  
                };
            this.showState=true;
            this.showWebcam=true;
            this.showFiles=false;
            this.showDash=true;
        };

        var pgSettings = new PGSettings();

        function updateWindowStates() {
            if (pgSettings.showState) {
                $("#state_wrapper").removeClass("pghidden");
            }
            else {
                $("#state_wrapper").addClass("pghidden");
            }
            if (pgSettings.showFiles) {
                $("#files_wrapper").removeClass("pghidden");
            }
            else {
                $("#files_wrapper").addClass("pghidden");
            }
            if (pgSettings.showWebcam) {
                $(".gwin #webcam_rotator").removeClass("pghidden");
            }
            else {
                $(".gwin #webcam_rotator").addClass("pghidden");
            }
            if (pgSettings.showDash) {
                $("#tab_plugin_dashboard").removeClass("pghidden");
            }
            else {
                $("#tab_plugin_dashboard").addClass("pghidden");
            }
        }


        var bedVolume = undefined;
        var viewInitialized = false;
        self.onTabChange = function (current, previous) {

            if (current == "#tab_plugin_prettygcode") {
                if (!viewInitialized) {
                    viewInitialized = true;

                    //get printer build volume.
                    //console.log(["self.printerProfiles",self.printerProfiles.currentProfileData()]);
                    var volume = self.printerProfiles.currentProfileData().volume;
                    if(typeof volume.custom_box ==="function")//check for custom bounds.
                    {
                        bedVolume={
                            width:volume.width(),
                            height:volume.height(),
                            depth:volume.depth(),
                            origin:volume.origin(),
                            formFactor:volume.formFactor(),
                        }
                    }else{
                        //console.log(["volume.custom_box",volume.custom_box]);
                        bedVolume={
                            width:volume.custom_box.x_max()-volume.custom_box.x_min(),
                            height:volume.custom_box.z_max()-volume.custom_box.z_min(),
                            depth:volume.custom_box.y_max()-volume.custom_box.y_min(),
                            origin:volume.origin(),
                            formFactor:volume.formFactor(),
                        }
                    }

                    console.log(["bedVolume",bedVolume]);

                    if(true){
                        //simple gui
                        dat.GUI.TEXT_OPEN="View Options"
                        dat.GUI.TEXT_CLOSED="View Options"
                        gui = new dat.GUI({ autoPlace: false,name:"View Options",closed:false,closeOnTop:true,useLocalStorage:true });
            
                        gui.useLocalStorage=true;
                        // var guielem = $("<div id='mygui' style='position:absolute;right:95px;top:20px;opacity:0.8;z-index:5;'></div>");
            
                        // $('.gwin').prepend(guielem)
            
                        $('#mygui').append(gui.domElement);

                        gui.remember(pgSettings);
                        gui.add(pgSettings, 'syncToProgress').onFinishChange(function(){
                            if(pgSettings.syncToProgress){
//                                syncLayerToZ();
                            }
                        });

                        gui.add(pgSettings, 'showMirror').onFinishChange(pgSettings.reloadGcode);
                        gui.add(pgSettings, 'fatLines').onFinishChange(pgSettings.reloadGcode);
                        gui.add(pgSettings, 'reflections');
                        gui.add(pgSettings, 'reloadGcode');
                        
                        var folder = gui.addFolder('Windows');//hidden.
                        folder.add(pgSettings, 'showState').onFinishChange(updateWindowStates).listen();
                        folder.add(pgSettings, 'showWebcam').onFinishChange(updateWindowStates).listen();
                        folder.add(pgSettings, 'showFiles').onFinishChange(updateWindowStates).listen();
                        folder.add(pgSettings, 'showDash').onFinishChange(updateWindowStates).listen();

                        //dont show Windows. Automatically handled by toggle buttons
                        $(folder.domElement).attr("hidden", true);

                    } 

                    initThree();

                    //load Nozzle model.
                    var objloader = new THREE.OBJLoader();
                    objloader.load( '/plugin/prettygcode/static/js/models/ExtruderNozzle.obj', function ( obj ) {
                        obj.quaternion.setFromEuler(new THREE.Euler( Math.PI / 2, 0, 0));
                        obj.scale.setScalar(0.1)
                        obj.position.set(0, 0, 10);
                        obj.name="nozzle";
                        var nozzleMaterial = new THREE.MeshStandardMaterial( {
                            metalness: 1,   // between 0 and 1
                            roughness: 0.5, // between 0 and 1
                            envMap: cubeCamera.renderTarget.texture,
                            color: new THREE.Color(0xba971b),
                            //flatShading:false,
                        } );
                        obj.children.forEach(function(e,i){
                            if ( e instanceof THREE.Mesh ) {
                                e.material = nozzleMaterial;
                                //e.geometry.computeVertexNormals();
                            }
                        })
                        nozzleModel=obj;
                        scene.add( obj );
                    } );

                    //GCode loader.
                    gcodeProxy = new GCodeParser();
                    var gcodeObject = gcodeProxy.getObject();
                    gcodeObject.position.set(-0, -0, 0);
                    scene.add(gcodeObject);

                    if(curJobName!="")
                        gcodeProxy.loadGcode('/downloads/files/local/' + curJobName);

       
                    //note this is an octoprint version of a bootstrap slider. not a jquery ui slider. 
                    $('.gwin').append($('<div id="myslider-vertical" style=""></div>'));
                    $("#myslider-vertical").slider({
                        id: "myslider",
                        orientation: "vertical",
                        reversed: true,
                        range: "min",
                        min: 0,
                        max: 100,
                        value: 100,
                    }).on("slide", function (event, ui) {
                        currentLayerNumber = event.value;
                    });;
                    $("#myslider").attr("style", "height:90%;position:absolute;top:5%;right:20px")


                    //Create a web camera inset for the view. 
                    var camView = $("#webcam_rotator").clone();
                    $(".gwin").append(camView)

                    //check url for fullscreen mode
                    if (urlParam("fullscreen"))
                        $(".page-container").addClass("pgfullscreen");

                    //setup window toggle buttons
                    $(".fstoggle").on("click", function () {
                        $(".page-container").toggleClass("pgfullscreen");
                    });
                    $(".pgsettingstoggle").on("click", function () {
                        $("#mygui").toggleClass("pghidden");
                    });
                    $(".pgstatetoggle").on("click", function () {
                        pgSettings.showState=!pgSettings.showState;
                        updateWindowStates();
                    });
                    $(".pgfilestoggle").on("click", function () {
                        pgSettings.showFiles=!pgSettings.showFiles;
                        updateWindowStates();
                    });
                    $(".pgcameratoggle").on("click", function () {
                        pgSettings.showWebcam=!pgSettings.showWebcam;
                        updateWindowStates();
                    }); 
                    $(".pgdashtoggle").on("click", function () {
                        pgSettings.showDash=!pgSettings.showDash;;
                        updateWindowStates();
                    });                                         
                    updateWindowStates();
                }

                //Activate webcam view in window. 
                $(".gwin #webcam_image").attr("src", "/webcam/?action=stream&" + Math.random())

            } else if (previous == "#tab_plugin_prettygcode") {
                //todo. disable animation 
                
                //Disable camera when tab isnt visible.
                $(".gwin #webcam_image").attr("src", "")
            }
        };

        //util function
        String.prototype.hashCode = function () {
            var hash = 0, i, chr;
            if (this.length === 0) return hash;
            for (i = 0; i < this.length; i++) {
                chr = this.charCodeAt(i);
                hash = ((hash << 5) - hash) + chr;
                hash |= 0; // Convert to 32bit integer
            }
            return hash;
        };

        //util function
        urlParam = function (name) {
            var results = new RegExp('[\?&]' + name + '=([^&#]*)').exec(window.location.href);
            if (results == null) {
                return null;
            }
            return decodeURI(results[1]) || 0;
        }

        //Handle "focus" url param. Not used anymore.
        var focus = urlParam("focus");
        if (focus != null) {
            console.log("Focusing on:" + focus);
            $("body").children().hide();
            $("#webcam_container").hide();
            if (!focus.startsWith("."))
                focus = "#" + focus;
            var el = $(focus)[0];
            $("body").prepend(el);
        }

        function GCodeParser(data) {

            var state = { x: 0, y: 0, z: 0, e: 0, f: 0, extruding: false, relative: false };
            var layers = [];
            
            var currentLayer = undefined;

            var defaultColor = new THREE.Color('black');
            var curColor = defaultColor;

            //material for fatlines
            var curMaterial = new THREE.LineMaterial({
                linewidth: 6, // in pixels
                //color: new THREE.Color(curColorHex),// rainbow.getColor(layers.length % 64).getHex()
                vertexColors: THREE.VertexColors,
            });
            //todo. handle window resize
//            curMaterial.resolution.set(gcodeWid, gcodeHei);
            curMaterial.resolution.set(500, 500);

            //for plain lines
            var curLineBasicMaterial = new THREE.LineBasicMaterial( {
                color: 0xffffff,
                vertexColors: THREE.VertexColors
            } );

            var gcodeGroup = new THREE.Group();
            gcodeGroup.name = 'gcode';

            this.reset=function()
            {
                this.clearObject();
                state = { x: 0, y: 0, z: 0, e: 0, f: 0, extruding: false, relative: false };
                layers = [];
                currentLayer = undefined;
                curColor = defaultColor;
            }
            this.getObject = function () {
                return gcodeGroup;
            }
           
            this.clearObject= function () {
                if(gcodeGroup){
                    for (var i = gcodeGroup.children.length - 1; i >= 0; i--) {
                        gcodeGroup.remove(gcodeGroup.children[i]);
                    }            
                }
            }

            this.currentUrl="";
            this.loadGcode=function(url) {
                this.reset();

                currentUrl=url;

                var parserObject=this;
                var file_url = url;//'/downloads/files/local/xxx.gcode';
                var myRequest = new Request(file_url);
                fetch(myRequest)
                    .then(function (response) {
                        var contentLength = response.headers.get('Content-Length');
                        if (!response.body || (!TextDecoder)) {
                            response.text().then(function (text) {
                                parserObject.parse(text);
                            });;
                        } else {
                            var myReader = response.body.getReader();
                            var decoder = new TextDecoder();
                            var buffer = '';
                            var received = 0;
                            myReader.read().then(function processResult(result) {
                                if (result.done) {
                                    parserObject.finishLoading();
                                    return;
                                }
                                received += result.value.length;
                                //                buffer += decoder.decode(result.value, {stream: true});
                                /* process the buffer string */
                                parserObject.parse(decoder.decode(result.value, { stream: true }));
    
                                // read the next piece of the stream and process the result
                                return myReader.read().then(processResult);
                            })
                        }
                    })
    
            }
            this.finishLoading=function()
            {
                if (currentLayer !== undefined) {
                    addObject(currentLayer, true);
                }
            }

            function addObject(layer, extruding) {

                if (layer.vertex.length > 2) { //Something to draw?
                    if(pgSettings.fatLines){//fancy lines
                        var geo = new THREE.LineGeometry();
                        geo.setPositions(layer.vertex);
                        geo.setColors(layer.colors)
                        var line = new THREE.Line2(geo, curMaterial);
                        line.name = 'layer#' + layers.length;
                        line.userData={layerZ:layer.z,layerNumber:layers.length+1};
                        gcodeGroup.add(line);
                        //line.renderOrder = 2;
                    }else{//plain lines
                        var geo = new THREE.BufferGeometry();
                        geo.addAttribute( 'position', new THREE.BufferAttribute( new Float32Array(layer.vertex), 3 ) );
                        geo.addAttribute( 'color', new THREE.BufferAttribute( new Float32Array(layer.colors), 3 ) );
                        var line = new THREE.LineSegments( geo, curLineBasicMaterial );
                        line.name = 'layer#' + layers.length;
                        line.userData={layerZ:layer.z,layerNumber:layers.length+1};
                        gcodeGroup.add(line);

                    }
                }
            }

            function newLayer(line) {
                if (currentLayer !== undefined) {
                    addObject(currentLayer, true);
                }

                currentLayer = { vertex: [], pathVertex: [], z: line.z, colors: [] };
                layers.push(currentLayer);
                //console.log("layer #" + layers.length + " z:" + line.z);

                if ($("#myslider-vertical").length) {
                    $("#myslider-vertical").slider("setMax", layers.length)
                    $("#myslider-vertical").slider("setValue", layers.length)
                    currentLayerNumber = layers.length;
                }
            }

            function addSegment(p1, p2) {
                if (currentLayer === undefined) {
                    newLayer(p1);
                }
                currentLayer.vertex.push(p1.x, p1.y, p1.z);
                currentLayer.vertex.push(p2.x, p2.y, p2.z);

                if (curColor != defaultColor) {
                    sceneBounds.expandByPoint(p1);
                    sceneBounds.expandByPoint(p2);
                }

                if(pgSettings.showMirror){
                        //add mirror version
                    currentLayer.vertex.push(p1.x, p1.y, -p1.z);
                    currentLayer.vertex.push(p2.x, p2.y, -p2.z);
                }

                if (true)//faux shading. Darken line color based on angle
                {
                    var deltaX = p2.x - p1.x;
                    var deltaY = p2.y - p1.y;
                    var rad = Math.atan2(deltaY, deltaX);

                    rad = Math.abs(rad)
                    var per = (rad) / (2.0 * 3.1415);
                    //console.log(rad + " " + per);

                    var drawColor = new THREE.Color(curColor)
                    var hsl = {}
                    drawColor.getHSL(hsl);

                    //darken every other line to make the layers easier to see.
                    if((layers.length%2)==0)
                        hsl.l = per+0.2;
                    else
                        hsl.l = per+0.25;

                    drawColor.setHSL(hsl.h,hsl.s,hsl.l);
                    //console.log(drawColor.r + " " + drawColor.g + " " + drawColor.b )
                    currentLayer.colors.push(drawColor.r, drawColor.g, drawColor.b);
                    currentLayer.colors.push(drawColor.r, drawColor.g, drawColor.b);

                    if(pgSettings.showMirror){
                        //add mirror version
                        drawColor.setHSL(hsl.h, hsl.s, hsl.l/2);
                        currentLayer.colors.push(drawColor.r, drawColor.g, drawColor.b);
                        currentLayer.colors.push(drawColor.r, drawColor.g, drawColor.b);
                    }
                }
                else {
                    currentLayer.colors.push(curColor.r, curColor.g, curColor.b);
                    currentLayer.colors.push(curColor.r, curColor.g, curColor.b);
                }
            }

            function delta(v1, v2) {
                return state.relative ? v2 : v2 - v1;
            }

            function absolute(v1, v2) {
                return state.relative ? v1 + v2 : v2;
            }

            var previousPiece = "";
            this.parse = function (chunk) {

                //remove comments from chunk.
                //var lines = chunk.replace(/;.+/g, '').split('\n');
                //or not
                var lines = chunk.split('\n');

                //handle partial lines from previous chunk.
                lines[0] = previousPiece + lines[0];
                previousPiece = lines[lines.length - 1];

                //note -1 so we dont process last line in case it is a partial.
                //Todo process the last line. Probably not needed since last line is usually gcode cleanup and not extruded lines.
                for (var i = 0; i < lines.length - 1; i++) {

                    var tokens = lines[i].split(' ');
                    var cmd = tokens[0].toUpperCase();

                    //Arguments
                    var args = {};
                    tokens.splice(1).forEach(function (token) {
                        if (token[0] !== undefined) {
                            var key = token[0].toLowerCase();
                            var value = parseFloat(token.substring(1));
                            args[key] = value;
                        }
                    });

                    //Process commands
                    //figure out line color from comments.
                    if (lines[i].indexOf(";")>-1 ) {
                        var cmdLower=lines[i].toLowerCase();
                        if (cmdLower.indexOf("inner") > -1) {
                            curColor = new THREE.Color(0x00ff00);//green
                        }
                        else if (cmdLower.indexOf("outer") > -1) {
                            curColor = new THREE.Color('red');
                        }
                        else if (cmdLower.indexOf("perimeter") > -1) {
                            curColor = new THREE.Color('red');
                        }
                        else if (cmdLower.indexOf("fill") > -1) {
                            curColor = new THREE.Color('orange');
                        }
                        else if (cmdLower.indexOf("skin") > -1) {
                            curColor = new THREE.Color('yellow');
                        }
                        else if (cmdLower.indexOf("support") > -1) {
                            curColor = new THREE.Color('skyblue');
                        }
                        else if (cmdLower.indexOf("skirt") > -1) {
                            curColor = new THREE.Color('skyblue');
                        }
                        else
                        {
                            var curColorHex = (Math.abs(cmd.hashCode()) & 0xffffff);
                            //curColor = new THREE.Color(curColorHex);
                            //console.log(cmd + ' ' + curColorHex.toString(16))
                        }
                        //console.log(lines[i])
                    }
                    //G0/G1 - Linear Movement
                    if (cmd === 'G0' || cmd === 'G1') {
                        var line = {
                            x: args.x !== undefined ? absolute(state.x, args.x) : state.x,
                            y: args.y !== undefined ? absolute(state.y, args.y) : state.y,
                            z: args.z !== undefined ? absolute(state.z, args.z) : state.z,
                            e: args.e !== undefined ? absolute(state.e, args.e) : state.e,
                            f: args.f !== undefined ? absolute(state.f, args.f) : state.f,
                        };
                        //Layer change detection is or made by watching Z, it's made by watching when we extrude at a new Z position
                        if (delta(state.e, line.e) > 0) {
                            var diff = delta(state.e, line.e);
                            line.extruding = delta(state.e, line.e) > 0;
                            if (currentLayer == undefined || line.z != currentLayer.z) {
                                newLayer(line);
                            }
                        }

                        //make sure extruding is updated. might not be needed.
                        //line.extruding = delta(state.e, line.e) > 0;
                        //if (line.extruding)
                        //    addSegment(state, line);//only if extruding right now.

                        //If E is defined in the args then extruding. Todo. is this right?
                        if(args.e !== undefined)
                            addSegment(state, line);//only if extruding right now.
                        state = line;
                    } else if (cmd === 'G2' || cmd === 'G3') {
                        //G2/G3 - Arc Movement ( G2 clock wise and G3 counter clock wise )
                        console.warn('THREE.GCodeLoader: Arc command not supported');
                    } else if (cmd === 'G90') {
                        //G90: Set to Absolute Positioning
                        state.relative = false;
                    } else if (cmd === 'G91') {
                        //G91: Set to state.relative Positioning
                        state.relative = true;
                    } else if (cmd === 'G92') {
                        //G92: Set Position
                        var line = state;
                        line.x = args.x !== undefined ? args.x : line.x;
                        line.y = args.y !== undefined ? args.y : line.y;
                        line.z = args.z !== undefined ? args.z : line.z;
                        line.e = args.e !== undefined ? args.e : line.e;
                        state = line;
                    } else {
                        //console.warn( 'THREE.GCodeLoader: Command not supported:' + cmd );
                    }
                }

                //update scene bounds.
                var bsize=new THREE.Vector3();
                sceneBounds.getSize(bsize);

                //todo. move this
                //updateDimensions(bsize); 
                 
                //Move zoom camera to new bounds.
                var dist = Math.max(Math.abs(bsize.x), Math.abs(bsize.y)) / 2;
                dist=Math.max(20,dist);//min distance to model.
                //console.log(dist)
                cameraControls.dollyTo(dist * 2.0 ,true);

            }

        };

        function updateDimensions(bsize) {

            if(dimensionsGroup===undefined)
            {
                dimensionsGroup = new THREE.Group();
                dimensionsGroup.name = 'dimensions';
                scene.add(dimensionsGroup);
            }

            var fontLoader = new THREE.FontLoader();
            fontLoader.load('/plugin/prettygcode/static/js/helvetiker_bold.typeface.json', function (font) {
                var xMid, text;
                var color = 0x006699;
                var matDark = new THREE.LineBasicMaterial({
                    color: color,
                    side: THREE.DoubleSide
                });
                var matLite = new THREE.MeshBasicMaterial({
                    color: color,
                    transparent: true,
                    opacity: 0.8,
                    side: THREE.DoubleSide
                });
                var center = new THREE.Vector3(0, 0, 0);
                sceneBounds.getCenter(center);
                //console.log(["center",center]);
                //clear out any old lines
                for (var i = dimensionsGroup.children.length - 1; i >= 0; i--) {
                    dimensionsGroup.remove(dimensionsGroup.children[i]);
                }
                var textHeight = 3;
                var textZ = 0.2;
                var message = bsize.x.toFixed(2) + " MM";
                var shapes = font.generateShapes(message, textHeight);
                var geometry = new THREE.ShapeBufferGeometry(shapes);
                geometry.computeBoundingBox();
                xMid = -0.5 * (geometry.boundingBox.max.x - geometry.boundingBox.min.x);
                geometry.translate(xMid, 0, 0);
                // make shape ( N.B. edge view not visible )
                text = new THREE.Mesh(geometry, matLite);
                text.position.set(center.x, sceneBounds.min.y - (textHeight * 2), textZ);
                dimensionsGroup.add(text);
                var lineMat = new THREE.LineMaterial({
                    linewidth: 6,
                    color: color
                });
                lineMat.resolution.set(gcodeWid, gcodeHei);
                var lineGeo = new THREE.LineGeometry();
                var lineVerts = [
                    sceneBounds.min.x, sceneBounds.min.y - (textHeight * 0.8), textZ,
                    sceneBounds.max.x, sceneBounds.min.y - (textHeight * 0.8), textZ,
                    sceneBounds.min.x, sceneBounds.min.y - 1, textZ,
                    sceneBounds.min.x, sceneBounds.min.y - (textHeight * 1.2), textZ,
                    sceneBounds.max.x, sceneBounds.min.y - 1, textZ,
                    sceneBounds.max.x, sceneBounds.min.y - (textHeight * 1.2), textZ,
                ];
                lineGeo.setPositions(lineVerts);
                var line = new THREE.Line2(lineGeo, lineMat);
                dimensionsGroup.add(line);
                var textHeight = 3;
                var message = bsize.y.toFixed(2) + " MM";
                var shapes = font.generateShapes(message, textHeight);
                var geometry = new THREE.ShapeBufferGeometry(shapes);
                geometry.computeBoundingBox();
                xMid = -0.5 * (geometry.boundingBox.max.x - geometry.boundingBox.min.x);
                geometry.translate(xMid, 0, 0);
                geometry.rotateZ(Math.PI / 2);
                // make shape ( N.B. edge view not visible )
                text = new THREE.Mesh(geometry, matLite);
                text.position.set(sceneBounds.max.x + (textHeight * 2), center.y, textZ);
                dimensionsGroup.add(text);
                var lineGeo = new THREE.LineGeometry();
                var lineVerts = [
                    sceneBounds.max.x + (textHeight * 0.8), sceneBounds.min.y, textZ,
                    sceneBounds.max.x + (textHeight * 0.8), sceneBounds.max.y, textZ,
                    sceneBounds.max.x + 1, sceneBounds.min.y, textZ,
                    sceneBounds.max.x + (textHeight * 1.2), sceneBounds.min.y, textZ,
                    sceneBounds.max.x + 1, sceneBounds.max.y, textZ,
                    sceneBounds.max.x + (textHeight * 1.2), sceneBounds.max.y, textZ,
                ];
                lineGeo.setPositions(lineVerts);
                var line = new THREE.Line2(lineGeo, lineMat);
                dimensionsGroup.add(line);
                var textHeight = 3;
                var message = bsize.z.toFixed(2) + " MM";
                var shapes = font.generateShapes(message, textHeight);
                var geometry = new THREE.ShapeBufferGeometry(shapes);
                geometry.computeBoundingBox();
                xMid = 0; // - 0.5 * ( geometry.boundingBox.max.x - geometry.boundingBox.min.x );
                geometry.translate(xMid, 0, 0);
                geometry.rotateX(Math.PI / 2);
                // make shape ( N.B. edge view not visible )
                text = new THREE.Mesh(geometry, matLite);
                text.position.set(sceneBounds.max.x + (textHeight * 1), sceneBounds.max.y, center.z);
                dimensionsGroup.add(text);
                var lineGeo = new THREE.LineGeometry();
                var lineVerts = [
                    sceneBounds.max.x + (textHeight * 0.8), sceneBounds.max.y + (textHeight * 0.8), 0,
                    sceneBounds.max.x + (textHeight * 0.8), sceneBounds.max.y + (textHeight * 0.8), bsize.z,
                ];
                lineGeo.setPositions(lineVerts);
                var line = new THREE.Line2(lineGeo, lineMat);
                dimensionsGroup.add(line);
            });
        }

        function resizeCanvasToDisplaySize() {
            const canvas = renderer.domElement;
            // look up the size the canvas is being displayed
            const width = canvas.clientWidth;
            const height = canvas.clientHeight;

            // adjust displayBuffer size to match
            if (canvas.width !== width || canvas.height !== height) {
                // you must pass false here or three.js sadly fights the browser
                renderer.setSize(width, height, false);
                camera.aspect = width / height;
                camera.updateProjectionMatrix();
                gcodeWid = width;
                gcodeHei = height;
                cameraControls.setViewport(0, 0, width, height);
            }
        }

        function initThree()
        {
            renderer = new THREE.WebGLRenderer({ canvas: document.getElementById("mycanvas") });
            //todo. is this right?
            renderer.setPixelRatio(window.devicePixelRatio);

            //todo allow save/pos camera at start.
            camera = new THREE.PerspectiveCamera(70, 2, 0.1, 10000);
            camera.up.set(0,0,1);
            camera.position.set(bedVolume.width, 0, 50);

            CameraControls.install({ THREE: THREE });
            clock = new THREE.Clock();

            var canvas = $("#mycanvas");
            cameraControls = new CameraControls(camera, canvas[0]);

            //todo handle other than lowerleft
            if(bedVolume.origin=="lowerleft")
                cameraControls.setTarget(bedVolume.width/2, bedVolume.depth/2, 0, false);
            else
                cameraControls.setTarget(0, 0, 0, false);


            //for debugging
            window.myCameraControls = cameraControls;

            //scene
            scene = new THREE.Scene();
            scene.background = new THREE.Color(0xd0d0d0);

            //for debugging
            window.myScene = scene;

            //add a light. might not be needed.
            var light = new THREE.PointLight(0xffffff);
            light.position.set(0, 0,-bedVolume.height);
            scene.add(light);
            
            // light = new THREE.PointLight(0xffffff);
            // light.position.set(bedVolume.width/2, bedVolume.depth/2,bedVolume.height);
            // scene.add(light);

            cameraLight = new THREE.PointLight(0xffffff);
            cameraLight.position.copy(camera.position);
            scene.add(cameraLight);

            // light = new THREE.AmbientLight( 0xffffff ); // soft white light
            // scene.add( light );

            // light = new THREE.PointLight(0xffffff);
            // light.position.copy(camera.position);
            // scene.add(light);
                       

            //Semi-transparent plane to represent the bed. 
            var planeGeometry = new THREE.PlaneGeometry( bedVolume.width, bedVolume.depth );
            var planeMaterial = new THREE.MeshBasicMaterial( {color: 0x909090, 
                side: THREE.DoubleSide,
                transparent: true,//pgSettings.transparency,
                opacity:0.2,
            });
            var plane = new THREE.Mesh( planeGeometry, planeMaterial );
            
            //todo handle other than lowerleft
            if(bedVolume.origin=="lowerleft")
                plane.position.set(bedVolume.width/2, bedVolume.depth/2,-0.1);

            //plane.quaternion.setFromEuler(new THREE.Euler(- Math.PI / 2, 0, 0));
            scene.add( plane );

            //todo. make bed sized. 

            var grid = new THREE.GridHelper(bedVolume.width, bedVolume.width/10, 0x000000, 0x888888);
            //todo handle other than lowerleft
            if(bedVolume.origin=="lowerleft")
                grid.position.set(bedVolume.width/2, bedVolume.depth/2,0);

            //if (pgSettings.transparency){
            grid.material.opacity = 0.6;
            grid.material.transparent = true;

            grid.quaternion.setFromEuler(new THREE.Euler(- Math.PI / 2, 0, 0));
            scene.add(grid);

            cubeCamera = new THREE.CubeCamera( 1, 100000, 128 );
            cubeCamera.position.set(bedVolume.width/2, bedVolume.depth/2,10);
            scene.add( cubeCamera );
            cubeCamera.update( renderer, scene );

            function animate() {

                const delta = clock.getDelta();
                const elapsed = clock.getElapsedTime();

                if(printHeadSim)
                {
                    printHeadSim.updatePosition(delta);
                    if(pgSettings.syncToProgress)
                    {
                        var curPos=printHeadSim.getCurPosition();

                        if(nozzleModel)
                            nozzleModel.position.copy(curPos);

                        //todo. factor this out?
                        scene.traverse(function (child) {
                            if (child.name.startsWith("layer#")) {
                                if (child.userData.layerZ <=curPos.z) {
                                    currentLayerNumber=child.userData.layerNumber;
                                }
                            }
                        });
                    }else{
                        if(nozzleModel)
                            nozzleModel.position.set(0,0,0);//todo. hide instead/also?
                    }

                }

                //do real time reflections. Probably overkill. Certianly overkill.
                if(pgSettings.reflections && cubeCamera && nozzleModel){
                    cubeCamera.position.copy( nozzleModel.position );
                    cubeCamera.position.z=cubeCamera.position.z+10;
                    nozzleModel.visible=false;
                    cubeCamera.update( renderer, scene );
                    nozzleModel.visible=true;
                }

                //set visible layers
                scene.traverse(function (child) {
                    if (child.name.startsWith("layer#")) {
                        var num = child.name.split("#")[1]
                        if (num < currentLayerNumber) {
                            child.visible = true;
                        }
                        else {
                            child.visible = false;
                        }
                    }
                });


                const updated = cameraControls.update(delta);
                cameraControls.dollyToCursor = true;

                if(cameraLight)
                {
                    cameraLight.position.copy(camera.position);
                }
                
                resizeCanvasToDisplaySize();

                renderer.render(scene, camera);
                requestAnimationFrame(animate);
            }

            animate();
        }
    }

    OCTOPRINT_VIEWMODELS.push({
        construct: PrettyGCodeViewModel,
        dependencies: ["settingsViewModel","loginStateViewModel", "printerProfilesViewModel"],
        elements: ["#injector_link"]
    });


});


