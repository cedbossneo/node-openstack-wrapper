var osutils = require('./os-utils');
var util = require('util');



//constructor - should be the only export
function Keystone(url, options)
{
  //we need to overwrite this for unit testing and it allows us to use a custom request object that includes graphite logging
  this.request = require('request');

  //this is an optional lib that we override to normalfy the openstack responses - leave as is for no munging
  this.mangler = require('./mangler');
  this.mangleObject = this.mangler.mangleObject;
  if (typeof options == 'undefined') {
    options = {};
  }
  if (typeof options.api_version == 'undefined') {
    this.api_version = 'v3';
  } else {
    this.api_version = options.api_version;
  }

  //Keystone v2 & v3 only are supported version at this point - add the url and yank all trailing slashes
  this.url = url.replace(/\/$/, "");

  //default the timeout to false - this forces the static value to be used
  this.timeout = false;
}



//allows for simple global timeouts if desired
Keystone.timeout = 9000;



//allows for instance timeouts if desired (see getRequestOptions)
Keystone.prototype.setTimeout = function(request_timeout)
{
  this.timeout = request_timeout;
};



//lets us override the existing request lib for this instance (useful for a bunch of things)
Keystone.prototype.setRequest = function(request_lib)
{
  this.request = request_lib;
};



//lets us mangle/sanitize/make sane the various responses from openstack
//any replacement must simply support a static mangleObject that supports the following types [ie mangleObject(type, object)]
//Project, Role, Assignment
Keystone.prototype.setMangler = function(mangle_lib)
{
  this.mangler = mangle_lib;
  this.mangleObject = this.mangler.mangleObject;
}



//returns an formatted options object - just makes the code below a little less repetitious
//auth_token can be either a generic or project scoped token depending what your doing
//json_value should be almost certainly be true if you don't have an actual object you want to send over
//NOTE: because keystone is non-project specific this function is different than all the other classes with it
Keystone.prototype.getRequestOptions = function(auth_token, path, json_value)
{
  //start w/the instance timeout
  var request_timeout = this.timeout;
  if(!request_timeout)
  {
    //override with the static value if no instance value was given
    request_timeout = Keystone.timeout;
  }
  var return_object = {
    uri: this.url + path,
    headers:{'X-Auth-Token': auth_token},
    json: json_value,
    timeout: request_timeout
  };

  return return_object;
};



//authorizes the users against the specified keystone
//calls back with (error, token) where token is an object containing all the token info
//NOTE: the actual token value normally comes back in the header - i'm modifying this to token.token for easier consumption
Keystone.prototype.getToken = function(username, password, tenantName, cb)
{
  var self = this;
  var auth_data = {};
  var uri;
  if (typeof tenantName == 'function') {
    cb = tenantName;
    delete tenantName;
  }
  if (self.api_version == 'v3') {
    auth_data = {
      auth:{
        identity:{
          methods: ['password'],
          'password': {user: {domain: {name: 'Default'}, name: username, 'password': password}}
        }
      }
    }
    uri = '/auth/tokens';
  } else if (self.api_version == 'v2') {
    // {"auth": {"tenantName": "openstack", "passwordCredentials": {"username": "admin", "password": "9K184HhdljmARX_lk210n"}}}
    auth_data = {
      auth:{
        passwordCredentials:{
          username: username,
          password: password
        }
      }
    }
    if (typeof tenantName != 'undefined') {
      auth_data['auth']['tenantName'] = tenantName;
    }
    uri = '/tokens';
  } else {
    //Todo handle unknown version
    console.log('Unknown version: ' + self.api_version);
  }
  var request_options = this.getRequestOptions('bogus', uri, auth_data);
  request_options.headers = {}; //we don't want the normal auth header due to bogus token
  request_options.logPath = 'api-calls.keystone.tokens-get';

  //auth-token will come back in the header for some reason as x-subject-token (used to come back in the body all nice like)
  this.request.post(request_options, function(error, response, body){
    if(osutils.isRequestError(error, response)
      || (!body.token && !body.access.token) || !response.headers
      || (!response.headers['x-subject-token'] && response.headers.vary != 'X-Auth-Token')
    ) {
      cb(osutils.getRequestError(error, response, body));
      return;
    }

    if (self.api_version == 'v3') {
      body.token.token = response.headers['x-subject-token'];
    } else if (self.api_version == 'v2') {
      body.token = {};
      body.token.token = body.access.token.id;
    }
    cb(null, self.mangleObject('Token', body.token));
  });
};



//make a callback(error, project_authorization) with all of the data on a project and an access token for further calls on it
//NOTE: this is not the admin function that gets project details - you have to do this so I'm not bothering with that
Keystone.prototype.getProjectTokenForReal = function(auth_data, cb)
{
  var self = this;
  
  //use the normal getRequestOptions but send in a bogus token and nullfiy the header
  //the token will get passed in the data in this call
  var request_options = this.getRequestOptions('bogus', '/auth/tokens', auth_data);
  request_options.headers = {};
  request_options.logPath = 'api-calls.keystone.tokens-get-project';
  
  this.request.post(request_options, function(error, response, body){
    if(osutils.isError(error, response) || !body.token || !response.headers || !response.headers['x-subject-token'])
    {
      cb(osutils.getError('keystone.getProjectToken', error, response, body));
      return;
    }

    body.token.token = response.headers['x-subject-token'];
    cb(null, self.mangleObject('ProjectToken', body.token));
  });
};



//make a callback(error, project_authorization) with all of the data on a project and an access token for further calls on it
//NOTE: this is not the admin function that gets project details - you have to do this so I'm not bothering with that
Keystone.prototype.getProjectToken = function(access_token, project_id, cb)
{
  var auth_data = {
    auth:{
      identity:{
        methods: ['token'],
        token: {id: access_token}
      },
      scope: {
        project: {id: project_id}
      }
    }
  };

  this.getProjectTokenForReal(auth_data, cb);
};



//passthru function for future stuff
Keystone.prototype.getProjectTokenById = Keystone.prototype.getProjectToken;



//make a callback(error, project_authorization) with all of the data on a project and an access token for further calls on it
//NOTE: this is not the admin function that gets project details - you have to do this so I'm not bothering with that
Keystone.prototype.getProjectTokenByName = function(access_token, domain_id, project_name, cb)
{
  var auth_data = {
    auth:{
      identity:{
        methods: ['token'],
        token: {id: access_token}
      },
      scope: {
        project: {
          domain: {id: domain_id},
          name: project_name
        }
      }
    }
  };

  this.getProjectTokenForReal(auth_data, cb);
};



//gets a list of all projects in the system
//calls back with cb(error, project_array)
//***NOTE: admin_access_token is a scoped token from a project you have admin rights on - yes this is weird
Keystone.prototype.listProjects = function(admin_access_token, cb)
{
  var self = this;
  var request_options = this.getRequestOptions(admin_access_token, '/projects', true);
  request_options.logPath = 'api-calls.keystone.projects-list';

  this.request.get(request_options, function(error, response, body){
    var projects_array =[];
    if(osutils.isError(error, response) || !body.projects || !util.isArray(body.projects) || !body.links || !body.links.self)
    {
      cb(osutils.getError('keystone.listProjects', error, response, body));
      return;
    }

    for(var n = 0; n < body.projects.length; n++)
    {
      projects_array[n] = self.mangleObject('Project', body.projects[n]);
    }

    //tack these on for easy consupmtion and in case we ever need pagination
    projects_array.self = body.links.self;
    projects_array.previous = body.links.previous;
    projects_array.next = body.links.next;

    cb(null, projects_array);
  });
};




//gets a list of projects the given token is authorized to have some access to
//calls back with (error, projects_array) and self, previous, and null are tacked on as properties of the array
Keystone.prototype.listUserProjects = function(username, access_token, cb)
{
  var self = this;
  var request_options = this.getRequestOptions(access_token, '/users/' + username + '/projects', true);
  request_options.logPath = 'api-calls.keystone.projects-list-user';

  this.request.get(request_options, function(error, response, body){
    var projects_array =[];
    if(osutils.isError(error, response) || !body.projects || !util.isArray(body.projects) || !body.links || !body.links.self)
    {
      cb(osutils.getError('keystone.listUserProjects', error, response, body));
      return;
    }
    
    for(var n = 0; n < body.projects.length; n++)
    {
      projects_array[n] = self.mangleObject('Project', body.projects[n]);
    }

    //tack these on for easy consupmtion and in case we ever need pagination
    projects_array.self = body.links.self;
    projects_array.previous = body.links.previous;
    projects_array.next = body.links.next;

    cb(null, projects_array);
  });
};



//gets the details of a specific project by name
//calls back with cb(error, project_array)
//***NOTE: admin_access_token is a scoped token from a project you have admin rights on - yes this is weird
//***NOTE: this will return an error if 2 projects are named the same - not usable unless distinct projects are configured/required.
Keystone.prototype.getProjectByName = function(admin_access_token, project_name, cb)
{
  var self = this;
  var request_options = this.getRequestOptions(admin_access_token, '/projects?name=' + project_name, true);
  request_options.logPath = 'api-calls.keystone.projects-get-by-name';

  this.request.get(request_options, function(error, response, body){
    var project_object = {};
    if(osutils.isError(error, response) || !body.projects || !util.isArray(body.projects))
    {
      cb(osutils.getError('keystone.getProjectByName', error, response, body));
      return;
    }
    if(body.projects.length > 1)
    {
      //kind of an error... in theory
      cb(osutils.getError('keystone.getProjectByName', 'Returned Multiple Values', response, body));
      return;
    }
    if(body.projects.length == 0)
    {
      //not an error but no data either
      cb(null, project_object);
      return;
    }

    //else we are good
    project_object = self.mangleObject('Project', body.projects[0]);
    cb(null, project_object);
  });
};



//gets a list of roles for the given project (specified by token ...kinda weird)
//calls back with (error, roles_array) and self, previous, and null are tacked on as properties of the array
//NOTE: this needs a project token scoped in our system - this may vary depending on how the security is setup
Keystone.prototype.listRoles = function(project_token, cb)
{
  var self = this;
  var request_options = this.getRequestOptions(project_token, '/roles', true);
  request_options.logPath = 'api-calls.keystone.roles-get';

  this.request.get(request_options, function(error, response, body){
    //console.log('roles', body);
    var n = 0;
    var roles_array = [];

    if(osutils.isError(error, response) || !body.roles || !util.isArray(body.roles) || !body.links || !body.links.self)
    {
      cb(osutils.getError('keystone.getRoles', error, response, body));
      return;
    }

    for(n = 0; n < body.roles.length; n++)
    {
      roles_array[n] = self.mangleObject('Role', body.roles[n]);
    }

    //tack these on for easy consupmtion and in case we ever need pagination
    roles_array.self = body.links.self;
    roles_array.previous = body.links.previous;
    roles_array.next = body.links.next;

    cb(null, roles_array);
  });
};



//make a callback(error, assignments_array) with all of the role assignments for a project
//NOTE: this is only works if the user is authed as an admin or projectAdmin
Keystone.prototype.listRoleAssignments = function(project_token, project_id, cb)
{
  var self = this;
  var request_options = this.getRequestOptions(project_token, '/role_assignments?scope.project.id=' + project_id, true);
  request_options.logPath = 'api-calls.keystone.role-assigments-list';

  this.request.get(request_options, function(error, response, body){
    var cb_error = null;
    var assignments_array = [];
    var n = 0;

    if(osutils.isError(error, response) || !body.role_assignments || !util.isArray(body.role_assignments) || !body.links || !body.links.self)
    {
      cb(osutils.getError('keystone.listRoleAssignments', error, response, body));
      return;
    }

    //else
    for(n = 0; n < body.role_assignments.length; n++)
    {
      assignments_array[n] = self.mangleObject('RoleAssignment', body.role_assignments[n]);
    }

    //tack these on for easy consupmtion and in case we ever need pagination
    assignments_array.self = body.links.self;
    assignments_array.previous = body.links.previous;
    assignments_array.next = body.links.next;

    cb(cb_error, assignments_array);
  });
};



//make a callback(error) after adding a specific role assignment to a project (either a user or a group)
//NOTE: this is only works if the user is authed as an admin or projectAdmin
Keystone.prototype.addRoleAssignment = function(project_token, project_id, entry_id, entry_type, role_id, cb)
{
  var request_options = {};
  var entry_type_path = 'users';

  if(entry_type == 'group')
  {
    entry_type_path = 'groups';
  }
  request_options = this.getRequestOptions(project_token, '/projects/' + project_id + '/' + entry_type_path + '/' + entry_id + '/roles/' + role_id, true);
  request_options.logPath = 'api-calls.keystone.role-assignments-add';

  this.request.put(request_options, function(error, response, body){
    if(osutils.isError(error, response) == true)
    {
      cb(osutils.getError('keystone.addRoleAssignment', error, response, body));
      return;
    }

    //else the body comes back as undefined instead of containing the new role assingment - lame
    //just call back with no error and we should be good
    cb();
  });
};



//make a callback(error) after removing a specific role assignments on a project(either a user or a group)
//NOTE: this is only works if the user is authed as an admin or projectAdmin
Keystone.prototype.removeRoleAssignment = function(project_token, project_id, entry_id, entry_type, role_id, cb)
{
  var request_options = {};
  var entry_type_path = 'users';

  if(entry_type == 'group')
  {
    entry_type_path = 'groups';
  }

  request_options = this.getRequestOptions(project_token, '/projects/' + project_id + '/' + entry_type_path + '/' + entry_id + '/roles/' + role_id, true);
  request_options.logPath = 'api-calls.keystone.role-assignments-remove';

  this.request.del(request_options, function(error, response, body){
    if(osutils.isError(error, response) == true)
    {
      cb(osutils.getError('keystone.removeProjectAssignment', error, response, body));
      return;
    }

    //else
    cb();
  });
};




//THE FOLLOWING ARE ONLY USEFUL WITHIN GODADDY (and are prioprietary functions until/if the project meta data work is adopted)
//THUS THEY AREN"T DOCUMENTED
//--------------------------------------------------------------------------
//make a callback(error) after retrieving all of the possible environments for the project/server meta data
//calls back with cb(error, environments_array)
Keystone.prototype.listMetaEnvironments = function(auth_token, cb)
{
  var self = this;
  var request_options = {};
  var environments_array = [];
  var n = 0;
    
  request_options = this.getRequestOptions(auth_token, '/meta_values/environment', true);
  request_options.logPath = 'api-calls.keystone.meta-environments-get';

  this.request.get(request_options, function(error, response, body){
    if(osutils.isError(error, response) == true || !util.isArray(body.environments))
    {
      cb(osutils.getError('keystone.listMetaEnvironments', error, response, body));
      return;
    }

    //else
    for(n = 0; n < body.environments.length; n++)
    {
      //this is a little silly since its just id/name but meh...
      environments_array[n] = self.mangleObject('MetaEnvironment', body.environments[n]);
    }
    cb(null, environments_array);
  });
};


//make a callback(error) after retrieving all of the possible ownsers for the project/server meta data
//calls back with cb(error, owning_groups_array)
Keystone.prototype.listMetaOwningGroups = function(auth_token, cb)
{
  var self = this;
  var request_options = {};
  var owning_groups_array = [];
  var n = 0;
  
  request_options = this.getRequestOptions(auth_token, '/meta_values/owning_group', true);
  request_options.logPath = 'api-calls.keystone.meta-owninggroups-get';

  this.request.get(request_options, function(error, response, body){
    if(osutils.isError(error, response) == true || !util.isArray(body.owning_groups))
    {
      cb(osutils.getError('keystone.listMetaOwningGroups', error, response, body));
      return;
    }

    //else
    for(n = 0; n < body.owning_groups.length; n++)
    {
      //this is a little silly since its just id/name but meh...
      owning_groups_array[n] = self.mangleObject('MetaOwningGroups', body.owning_groups[n]);
    }
    cb(null, owning_groups_array);
  });
};


//make a callback(error) after listing all of the project meta data
//calls back with cb(error, meta_object)
Keystone.prototype.listProjectMeta = function(project_token, project_id, cb)
{
  var self = this;
  var request_options = {};
  var meta_object = {};
  
  request_options = this.getRequestOptions(project_token, '/projects/' + project_id + '/meta', true);
  request_options.logPath = 'api-calls.keystone.projects-meta-get';

  this.request.get(request_options, function(error, response, body){
    if(osutils.isError(error, response) == true || !body.meta)
    {
      cb(osutils.getError('keystone.listProjectMeta', error, response, body));
      return;
    }
    //else
    
    meta_object = self.mangleObject('ProjectMeta', body.meta);
    cb(null, meta_object);
  });
};


//make a callback(error) after updating the project meta data
//meta_data should be an object with key-value pairs ie: {environment: 'dev', group: 'marketing'}
//calls back with cb(error, meta_object)
Keystone.prototype.updateProjectMeta = function(project_token, project_id, new_meta, cb)
{
  var self = this;
  var request_options = {};
  var meta_data = {meta: new_meta}
  var meta_object = {};
  
  request_options = this.getRequestOptions(project_token, '/projects/' + project_id + '/meta', meta_data);
  request_options.logPath = 'api-calls.keystone.projects-meta-update';
  
  this.request.put(request_options, function(error, response, body){
    if(osutils.isError(error, response) == true || !body.meta)
    {
      cb(osutils.getError('keystone.updateProjectMeta', error, response, body));
      return;
    }
    //else
    
    meta_object = self.mangleObject('ProjectMeta', body.meta);
    cb(null, meta_object);
  });
};




module.exports = Keystone;
